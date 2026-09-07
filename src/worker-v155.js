import postWorker from './worker-v154.js';
import { neon } from '@neondatabase/serverless';

const MANUAL_KEY='blocked_manual_v1';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return postWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      const p=url.pathname;
      if (p === '/api/health' && request.method === 'GET') return health155(request, env, ctx);
      if (p === '/api/dispute-helper/draft' && request.method === 'POST') return makeDraft(request);
      if (p === '/api/blocked-content' && request.method === 'GET') return blockedContent(url,env);
      if (p === '/api/blocked-content/manual' && request.method === 'POST') return addManualCase(request,env);
      const m=p.match(/^\/api\/blocked-content\/manual\/([^/]+)$/);
      if(m&&request.method==='DELETE') return deleteManualCase(env,decodeURIComponent(m[1]));
      return postWorker.fetch(request, env, ctx);
    } catch (e) {
      return json({ ok:false, error:String(e?.message || e) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    return postWorker.scheduled(controller, env, ctx);
  }
};

function json(data,status=200){
  return Response.json(data,{status,headers:{
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,HEAD,POST,DELETE,OPTIONS',
    'access-control-allow-headers':'content-type,authorization,range',
    'cache-control':'no-store'
  }});
}
function db(env){if(!env.DATABASE_URL)throw new Error('DATABASE_URL is not configured in Cloudflare');return neon(env.DATABASE_URL)}
async function stateGet(env,key){const r=await db(env)`SELECT value FROM app_state WHERE key=${key}`;return r[0]?.value??null}
async function stateSet(env,key,value){await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`}
async function getAccounts(env){const v=await stateGet(env,'accounts');return Array.isArray(v)?v:[]}
function graphVersion(env){return String(env.GRAPH_API_VERSION||'v23.0').trim()}
function unhex(s){if(!s||s.length%2)throw new Error('Invalid encrypted payload');const out=new Uint8Array(s.length/2);for(let i=0;i<out.length;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out}
async function secretKey(env){if(!env.APP_SECRET_KEY)throw new Error('APP_SECRET_KEY is not configured in Cloudflare');const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.APP_SECRET_KEY));return crypto.subtle.importKey('raw',d,{name:'AES-GCM'},false,['decrypt'])}
async function decrypt(env,payload){const [ivh,tagh,datah]=String(payload||'').split('.');if(!ivh||!tagh||datah===undefined)throw new Error('Encrypted payload is invalid');const key=await secretKey(env),iv=unhex(ivh),tag=unhex(tagh),data=unhex(datah),all=new Uint8Array(data.length+tag.length);all.set(data);all.set(tag,data.length);const out=await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,all);return new TextDecoder().decode(out)}
async function graphGet(env,path,params,token){const u=new URL(`https://graph.instagram.com/${graphVersion(env)}/${path}`);for(const[k,v]of Object.entries(params||{}))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));u.searchParams.set('access_token',token);const r=await fetch(u);const x=await r.json().catch(()=>({}));if(!r.ok||x.error)throw new Error(x.error?.message||`Meta API HTTP ${r.status}`);return x}

async function health155(request,env,ctx){
  const r=await postWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);
  if(!x)return r;
  return json({...x,version:'15.5.0',features:{...(x.features||{}),disputeHelper:true,blockedContentCenter:true,blockedAutoDetect:true,rightsSignalScan:true,autoDisputeSubmission:false}});
}

function classifyJob(job){
  const s=[job.error,job.lastContainerStatusText,job.lastErrorType,job.status].filter(Boolean).join(' ').toLowerCase();
  if(/copyright|intellectual property|rights owner|rights violation|copyrighted|licensed audio/.test(s)) return {kind:'copyright_block',severity:'blocked',title:'Copyright / rights issue'};
  if(/blocked|removed|can.?t view|cannot view|not available|restricted in/.test(s)) return {kind:'content_block',severity:'blocked',title:'Content blocked / unavailable'};
  if(/community standards|policy|violation|abusive|code 368|\b368\b/.test(s)) return {kind:'policy_block',severity:'blocked',title:'Policy restriction'};
  if(/instagram account is restricted|2207050|account.*restricted/.test(s)) return {kind:'account_restricted',severity:'account',title:'Account restricted'};
  return null;
}

async function blockedContent(url,env){
  const accountId=String(url.searchParams.get('accountId')||'all');
  const scan=url.searchParams.get('scan')==='1';
  const limit=Math.max(20,Math.min(500,Number(url.searchParams.get('limit')||250)));
  const accounts=await getAccounts(env),allowed=new Set(accounts.map(a=>String(a.id)));
  if(accountId!=='all'&&!allowed.has(accountId))return json({error:'Connected account not found'},404);
  const rows=accountId==='all'
    ? await db(env)`SELECT value FROM jobs_state WHERE value ? 'error' OR value->>'status' IN ('failed','retry_wait') ORDER BY updated_at DESC LIMIT ${limit}`
    : await db(env)`SELECT value FROM jobs_state WHERE value->>'accountId'=${accountId} AND (value ? 'error' OR value->>'status' IN ('failed','retry_wait')) ORDER BY updated_at DESC LIMIT ${limit}`;
  const items=[];
  for(const r of rows){const v=r.value||{},c=classifyJob(v);if(!c)continue;items.push({id:`job:${v.id}`,source:'publisher',...c,accountId:v.accountId,accountLabel:v.accountLabel||accounts.find(a=>String(a.id)===String(v.accountId))?.label||'',fileName:v.fileName||'video',postUrl:v.permalink||null,mediaId:v.publishedMediaId||null,status:v.status||null,reason:v.error||v.lastContainerStatusText||c.title,detectedAt:v.lastAttemptAt||v.publishedAt||v.scheduledAt||v.createdAt||new Date().toISOString(),claimant:null,canDispute:true});}
  const manual=(await stateGet(env,MANUAL_KEY))||[];
  for(const m of Array.isArray(manual)?manual:[]){if(accountId!=='all'&&String(m.accountId)!==accountId)continue;items.push({...m,source:'manual',severity:'blocked',kind:m.kind||'manual_block',title:m.title||'Blocked content report',canDispute:true})}
  const scanErrors=[];
  if(scan){
    const targets=accountId==='all'?accounts:accounts.filter(a=>String(a.id)===accountId);
    for(const a of targets){
      try{
        const token=await decrypt(env,a.tokenEnc);
        const x=await graphGet(env,`${a.igUserId}/media`,{fields:'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count',limit:30},token);
        for(const p of (x.data||[])){
          const type=String(p.media_type||p.media_product_type||'').toUpperCase();
          if((type==='VIDEO'||type==='REELS'||type==='REEL')&&!p.media_url){
            items.push({id:`rights:${a.id}:${p.id}`,source:'instagram_scan',kind:'rights_signal',severity:'review',title:'Rights signal detected',accountId:a.id,accountLabel:a.label,fileName:String(p.caption||'Instagram video').slice(0,80)||'Instagram video',postUrl:p.permalink||null,mediaId:String(p.id),status:'published_or_restricted',reason:'Instagram did not return media_url for this video. This can indicate copyrighted/licensed audio or a copyright-related restriction. It is a review signal, not proof that the post is blocked.',detectedAt:p.timestamp||new Date().toISOString(),claimant:null,canDispute:true,signalOnly:true});
          }
        }
      }catch(e){scanErrors.push({accountId:a.id,label:a.label,error:e.message})}
    }
  }
  const dedup=new Map();for(const i of items){const k=`${i.accountId}|${i.mediaId||''}|${i.postUrl||''}|${i.fileName||''}|${i.kind}`;if(!dedup.has(k))dedup.set(k,i)}
  const out=[...dedup.values()].sort((a,b)=>new Date(b.detectedAt||0)-new Date(a.detectedAt||0));
  return json({ok:true,count:out.length,blockedCount:out.filter(x=>x.severity==='blocked').length,reviewCount:out.filter(x=>x.severity==='review').length,items:out,scanPerformed:scan,scanErrors,limitations:'Instagram API does not expose a complete copyright/account-status inbox. This center combines publisher errors, saved manual cases, and rights signals from accessible media metadata. Final disputes must be submitted through Instagram/Meta official review flows.'});
}

async function addManualCase(request,env){
  const b=await request.json().catch(()=>({})),accounts=await getAccounts(env),account=accounts.find(a=>String(a.id)===String(b.accountId||''));
  if(!account)return json({error:'Connected account is required'},400);
  const postUrl=String(b.postUrl||'').trim(),reason=String(b.reason||'').trim(),claimant=String(b.claimant||'').trim();
  if(!postUrl&&!reason)return json({error:'Post URL or block reason is required'},400);
  const list=(await stateGet(env,MANUAL_KEY))||[],item={id:`manual:${crypto.randomUUID()}`,kind:'manual_block',severity:'blocked',title:'Blocked content report',accountId:account.id,accountLabel:account.label,fileName:String(b.fileName||'Blocked Instagram video').slice(0,160),postUrl:postUrl||null,mediaId:String(b.mediaId||'').trim()||null,status:'reported_blocked',reason:reason||'Reported as blocked in Instagram',detectedAt:new Date().toISOString(),claimant:claimant||null,canDispute:true};
  await stateSet(env,MANUAL_KEY,[item,...(Array.isArray(list)?list:[])].slice(0,500));return json({ok:true,item});
}
async function deleteManualCase(env,id){const list=(await stateGet(env,MANUAL_KEY))||[],next=(Array.isArray(list)?list:[]).filter(x=>String(x.id)!==String(id));if(next.length===list.length)return json({error:'Manual case not found'},404);await stateSet(env,MANUAL_KEY,next);return json({ok:true,deleted:id})}

function clean(v,max=1200){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max)}
function basisLabel(v){return ({original:'I created and own the material',licensed:'I have a valid license to use the material',permission:'I have permission from the rights holder',public_domain:'The material is in the public domain',misidentification:'The claim appears to identify the wrong material',other:'I have another legitimate rights basis'})[v]||'I have a legitimate rights basis'}
function evidenceLine(b){if(b==='original')return 'I can provide original source files, project files, timestamps, or other creation records if needed.';if(b==='licensed')return 'I can provide the relevant license, invoice, receipt, or licensing terms if needed.';if(b==='permission')return 'I can provide written permission or authorization from the rights holder if needed.';if(b==='public_domain')return 'I can provide the source and documentation supporting the public-domain status if needed.';if(b==='misidentification')return 'I can provide source material and comparison details showing why the claimed work does not match my post.';return 'I can provide supporting documentation for my rights basis if needed.'}
async function makeDraft(request){
  const b=await request.json().catch(()=>({}));
  if(b.confirmedRights!==true)return json({ok:false,error:'Please confirm that you have a genuine rights/permission basis before generating a dispute draft.'},400);
  const claimant=clean(b.claimant,200),notice=clean(b.notice,500),post=clean(b.postDescription,500),evidence=clean(b.evidence,1000),basis=clean(b.rightsBasis,50)||'other',account=clean(b.accountLabel,120),name=clean(b.name,120);
  if(!post&&!notice)return json({ok:false,error:'Add the blocked-post description or the claim/notice details first.'},400);
  const subject=`Request for review of copyright restriction${account?` on @${account}`:''}`;
  const lines=['Hello Meta/Instagram Review Team,','',`I am requesting a review of the copyright restriction on ${post||'my Instagram post'}.`,claimant?`The notice/claim identifies ${claimant} as the claimant or rights owner.`:'',notice?`Notice details: ${notice}`:'','',`${basisLabel(basis)}.`,evidenceLine(basis),evidence?`Supporting details: ${evidence}`:'','','I am submitting this request in good faith and only on the basis of information I believe to be accurate. Please review the restriction and the supporting rights information. If additional documentation is required, please let me know what is needed.','','Thank you,',name||account||'Account owner'].filter(Boolean);
  return json({ok:true,subject,draft:lines.join('\n'),checklist:['Only submit if the rights/permission basis is genuine.','Attach license, written permission, source files, invoices, or other evidence that supports your claim.','Use the exact claimant and notice details shown by Instagram/Meta.','Do not claim ownership, a license, or permission that you do not actually have.','Submit the final dispute through the official Instagram/Meta review flow shown for the affected post or account.'],autoSubmit:false});
}
