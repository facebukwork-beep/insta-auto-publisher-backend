import baseWorker from './worker.js';
import { neon } from '@neondatabase/serverless';

const ACTIVE = new Set(['scheduled','processing','ready','publishing','retry_wait']);
const DEFAULT_BURST = { size: 5, gapMinutes: 10, breakMinutes: 60 };
const PERF_CACHE_KEY = 'performance_cache_v1';
const ACCOUNT_CONTROL_KEY = 'account_controls_v1';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return baseWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/health' && request.method === 'GET') return enhancedHealth(request, env, ctx);
      if (path === '/api/account-controls' && request.method === 'GET') return getAccountControlsResponse(env);
      if (path === '/api/accounts/bulk-control' && request.method === 'POST') return bulkAccountControl(request, env);
      let m = path.match(/^\/api\/accounts\/([^/]+)\/(pause|resume)$/);
      if (m && request.method === 'POST') return accountControl(env, decodeURIComponent(m[1]), m[2]);
      if (path === '/api/calendar/next24h' && request.method === 'GET') return next24Calendar(url, env);
      if (path === '/api/performance' && request.method === 'GET') return performanceResponse(url, env);
      if (path === '/api/best-times' && request.method === 'GET') return bestTimesResponse(url, env);
      if (path === '/api/duplicates/check' && request.method === 'POST') return duplicatesCheck(request, env);
      if (path === '/api/schedule-direct' && request.method === 'POST') return scheduleDirectEnhanced(request, env, ctx);
      if (path === '/api/scheduler/status' && request.method === 'GET') return schedulerStatusEnhanced(request, env, ctx);
      return baseWorker.fetch(request, env, ctx);
    } catch (e) {
      return j({ ok:false, error:String(e?.message || e) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    return baseWorker.scheduled(controller, env, ctx);
  }
};

function j(data, status=200) {
  return Response.json(data, { status, headers: {
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,HEAD,POST,DELETE,OPTIONS',
    'access-control-allow-headers':'content-type,authorization,range',
    'cache-control':'no-store'
  }});
}
function db(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured in Cloudflare');
  return neon(env.DATABASE_URL);
}
async function stateGet(env,key){ const r=await db(env)`SELECT value FROM app_state WHERE key=${key}`; return r[0]?.value ?? null; }
async function stateSet(env,key,value){ await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`; }
async function getAccounts(env){ const v=await stateGet(env,'accounts'); return Array.isArray(v)?v:[]; }
async function getControls(env){ const v=await stateGet(env,ACCOUNT_CONTROL_KEY); return v && typeof v==='object' ? v : {}; }
async function saveControls(env,v){ await stateSet(env,ACCOUNT_CONTROL_KEY,v); }
function burstOffset(index, spec=DEFAULT_BURST){ const group=Math.floor(index/spec.size), within=index%spec.size; return (group*((spec.size-1)*spec.gapMinutes+spec.breakMinutes)+within*spec.gapMinutes)*60000; }
function fmtHour(hour){ const h=((Number(hour)%24)+24)%24; const ap=h>=12?'PM':'AM'; const h12=h%12||12; return `${h12}:00 ${ap}`; }
function offsetHour(ts, offsetMin){ return new Date(new Date(ts).getTime()+offsetMin*60000).getUTCHours(); }
function graphVersion(env){ return String(env.GRAPH_API_VERSION||'v23.0').trim(); }
function hex(bytes){ return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function hashText(s){ const b=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(s))); return hex(new Uint8Array(b)); }

async function secretKey(env){
  if(!env.APP_SECRET_KEY) throw new Error('APP_SECRET_KEY is not configured in Cloudflare');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.APP_SECRET_KEY));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt']);
}
function unhex(s){ const out=new Uint8Array(s.length/2); for(let i=0;i<out.length;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16); return out; }
async function decrypt(env,payload){
  const [ivh,tagh,datah]=String(payload||'').split('.');
  if(!ivh||!tagh||datah===undefined) throw new Error('Encrypted payload is invalid');
  const key=await secretKey(env),iv=unhex(ivh),tag=unhex(tagh),data=unhex(datah),all=new Uint8Array(data.length+tag.length);
  all.set(data); all.set(tag,data.length);
  const out=await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,all);
  return new TextDecoder().decode(out);
}
async function graph(env,path,params,token){
  const u=new URL(`https://graph.instagram.com/${graphVersion(env)}/${path}`);
  for(const [k,v] of Object.entries(params||{})) if(v!==undefined&&v!==null) u.searchParams.set(k,String(v));
  u.searchParams.set('access_token',token);
  const r=await fetch(u); const x=await r.json().catch(()=>({}));
  if(!r.ok||x.error) throw new Error(x.error?.message||`Meta API HTTP ${r.status}`);
  return x;
}
function insightValue(item){
  if(item==null) return null;
  if(Number.isFinite(Number(item.total_value?.value))) return Number(item.total_value.value);
  if(Array.isArray(item.values)&&item.values.length){ const v=item.values[item.values.length-1]?.value; if(Number.isFinite(Number(v))) return Number(v); }
  if(Number.isFinite(Number(item.value))) return Number(item.value);
  return null;
}

async function enhancedHealth(request,env,ctx){
  const r=await baseWorker.fetch(request,env,ctx); const x=await r.clone().json().catch(()=>null);
  if(!x) return r;
  return j({...x,version:'15.3.0',features:{calendar24h:true,accountPause:true,bestTime:true,performanceDashboard:true,duplicateProtection:true,appendExisting:true}});
}
async function schedulerStatusEnhanced(request,env,ctx){
  const r=await baseWorker.fetch(request,env,ctx); const x=await r.clone().json().catch(()=>({}));
  const controls=await getControls(env); const pausedAccounts=Object.values(controls).filter(v=>v?.paused).length;
  return j({...x,accountPause:true,pausedAccounts});
}

async function getAccountControlsResponse(env){
  const accounts=await getAccounts(env), controls=await getControls(env);
  return j({ok:true,accounts:accounts.map(a=>({accountId:a.id,label:a.label,igUserId:a.igUserId,paused:!!controls[a.id]?.paused,pausedAt:controls[a.id]?.pausedAt||null,resumedAt:controls[a.id]?.resumedAt||null}))});
}
async function bulkAccountControl(request,env){
  const b=await request.json().catch(()=>({})), ids=[...new Set((b.accountIds||[]).map(String))].slice(0,15), action=String(b.action||'').toLowerCase();
  if(!ids.length) return j({error:'accountIds are required'},400);
  if(!['pause','resume'].includes(action)) return j({error:'action must be pause or resume'},400);
  let changed=0,rebasedJobs=0; for(const id of ids){ const r=await applyAccountControl(env,id,action); if(r.changed)changed++; rebasedJobs+=r.rebasedJobs||0; }
  return j({ok:true,action,changedAccounts:changed,rebasedJobs});
}
async function accountControl(env,id,action){ const r=await applyAccountControl(env,id,action); return j({ok:true,accountId:id,action,...r}); }
async function applyAccountControl(env,accountId,action){
  const accounts=await getAccounts(env); if(!accounts.some(a=>a.id===accountId)) throw new Error('Account not found');
  const controls=await getControls(env), now=Date.now(), ctl=controls[accountId]||{paused:false};
  const sql=db(env);
  if(action==='pause'){
    if(ctl.paused) return {changed:false,paused:true,rebasedJobs:0};
    const rows=await sql`SELECT value FROM jobs_state WHERE value->>'accountId'=${accountId} AND value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait')`;
    const far=10*365*24*60*60*1000;
    const jobs=rows.map(r=>r.value).map(job=>{
      if(!job.accountPauseOriginalScheduledAt) job.accountPauseOriginalScheduledAt=job.scheduledAt;
      if(job.nextAttemptAt&&!job.accountPauseOriginalNextAttemptAt) job.accountPauseOriginalNextAttemptAt=job.nextAttemptAt;
      const t=new Date(job.scheduledAt).getTime(); job.scheduledAt=new Date((Number.isFinite(t)?t:now)+far).toISOString();
      if(job.nextAttemptAt){ const n=new Date(job.nextAttemptAt).getTime(); if(Number.isFinite(n)) job.nextAttemptAt=new Date(n+far).toISOString(); }
      if(['processing','ready'].includes(job.status)){job.status='scheduled';job.containerId=null;job.preparedAt=null;job.readyAt=null;job.nextAttemptAt=null;}
      job.accountPaused=true; job.accountPausedAt=new Date(now).toISOString(); return job;
    });
    if(jobs.length) await upsertJobs(env,jobs);
    controls[accountId]={...ctl,paused:true,pausedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()}; await saveControls(env,controls);
    return {changed:true,paused:true,affectedJobs:jobs.length,rebasedJobs:0};
  }
  if(!ctl.paused) return {changed:false,paused:false,rebasedJobs:0};
  const pausedAt=new Date(ctl.pausedAt||now).getTime(), pauseDur=Math.max(0,now-pausedAt);
  const rows=await sql`SELECT value FROM jobs_state WHERE value->>'accountId'=${accountId} AND value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait') ORDER BY COALESCE((value->>'accountPauseOriginalScheduledAt')::timestamptz,(value->>'scheduledAt')::timestamptz) ASC`;
  const jobs=rows.map(r=>r.value);
  for(const job of jobs){
    const orig=new Date(job.accountPauseOriginalScheduledAt||job.scheduledAt).getTime();
    job.scheduledAt=new Date((Number.isFinite(orig)?orig:now)+pauseDur).toISOString();
    if(job.accountPauseOriginalNextAttemptAt){ const n=new Date(job.accountPauseOriginalNextAttemptAt).getTime(); if(Number.isFinite(n))job.nextAttemptAt=new Date(n+pauseDur).toISOString(); }
    job.accountPaused=false; delete job.accountPauseOriginalScheduledAt; delete job.accountPauseOriginalNextAttemptAt; delete job.accountPausedAt;
  }
  let rebased=0;
  if(jobs.length){
    const earliest=Math.min(...jobs.map(x=>new Date(x.scheduledAt).getTime()).filter(Number.isFinite));
    if(!Number.isFinite(earliest)||earliest<now+30000){ const start=now+60000; jobs.forEach((job,i)=>{job.scheduledAt=new Date(start+burstOffset(i)).toISOString();job.catchupReason='account_resume_catchup';job.catchupRebasedAt=new Date().toISOString();}); rebased=jobs.length; }
    await upsertJobs(env,jobs);
  }
  controls[accountId]={...ctl,paused:false,pausedAt:null,resumedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()}; await saveControls(env,controls);
  return {changed:true,paused:false,affectedJobs:jobs.length,rebasedJobs:rebased};
}
async function upsertJobs(env,jobs){ if(!jobs.length)return; await db(env)`INSERT INTO jobs_state(id,value,updated_at) SELECT x->>'id',x,NOW() FROM jsonb_array_elements(${JSON.stringify(jobs)}::jsonb) x ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`; }

async function next24Calendar(url,env){
  const start=Date.now(),end=start+24*60*60*1000,controls=await getControls(env);
  const rows=await db(env)`SELECT value FROM jobs_state WHERE value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait') AND COALESCE((value->>'accountPauseOriginalScheduledAt')::timestamptz,(value->>'scheduledAt')::timestamptz)>=to_timestamp(${start/1000}) AND COALESCE((value->>'accountPauseOriginalScheduledAt')::timestamptz,(value->>'scheduledAt')::timestamptz)<to_timestamp(${end/1000}) ORDER BY COALESCE((value->>'accountPauseOriginalScheduledAt')::timestamptz,(value->>'scheduledAt')::timestamptz) ASC LIMIT 1000`;
  const jobs=rows.map(r=>{const x=r.value;return{...x,displayScheduledAt:x.accountPauseOriginalScheduledAt||x.scheduledAt,accountPaused:!!controls[x.accountId]?.paused}});
  return j({ok:true,from:new Date(start).toISOString(),to:new Date(end).toISOString(),count:jobs.length,jobs});
}

async function performanceResponse(url,env){
  const accountId=String(url.searchParams.get('accountId')||''), offset=Math.max(-840,Math.min(840,Number(url.searchParams.get('tzOffsetMinutes')||330))), force=url.searchParams.get('refresh')==='1';
  if(!accountId) return j({error:'accountId is required'},400);
  return j(await getPerformance(env,accountId,offset,force));
}
async function getPerformance(env,accountId,offset,force=false){
  const cache=(await stateGet(env,PERF_CACHE_KEY))||{}, cached=cache[accountId], ttl=30*60*1000;
  if(!force&&cached&&Date.now()-new Date(cached.fetchedAt||0).getTime()<ttl) return {...cached,cached:true};
  const account=(await getAccounts(env)).find(a=>a.id===accountId); if(!account) throw new Error('Account not found');
  const token=await decrypt(env,account.tokenEnc);
  let media=[]; let apiError=null;
  try{
    const list=await graph(env,`${account.igUserId}/media`,{fields:'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count',limit:12},token);
    media=Array.isArray(list.data)?list.data:[];
  }catch(e){apiError=e.message;}
  const items=[];
  for(const m of media){
    let reach=null,views=null,insightError=null;
    for(const metrics of ['reach,views','reach,plays','reach']){
      try{ const ins=await graph(env,`${m.id}/insights`,{metric:metrics},token); for(const it of (ins.data||[])){ const name=String(it.name||''); const val=insightValue(it); if(name==='reach'&&val!==null)reach=val; if((name==='views'||name==='plays')&&val!==null)views=val; } break; }catch(e){ insightError=e.message; }
    }
    const likes=Number(m.like_count||0),comments=Number(m.comments_count||0),score=(views||0)+0.55*(reach||0)+4*likes+8*comments;
    items.push({id:m.id,caption:String(m.caption||'').slice(0,160),mediaType:m.media_type||m.media_product_type||null,timestamp:m.timestamp,permalink:m.permalink||null,likes,comments,reach,views,score:Math.round(score),hour:offsetHour(m.timestamp,offset),insightError:reach===null&&views===null?insightError:null});
  }
  items.sort((a,b)=>b.score-a.score);
  const buckets=new Map(); for(const it of items){const b=buckets.get(it.hour)||{hour:it.hour,score:0,posts:0,views:0,reach:0};b.score+=it.score;b.posts++;b.views+=it.views||0;b.reach+=it.reach||0;buckets.set(it.hour,b);}
  let bestHours=[...buckets.values()].map(b=>({...b,avgScore:Math.round(b.score/Math.max(1,b.posts)),label:fmtHour(b.hour)})).sort((a,b)=>b.avgScore-a.avgScore||b.posts-a.posts).slice(0,3);
  let source='media_performance';
  if(!bestHours.length){
    const rows=await db(env)`SELECT value FROM jobs_state WHERE value->>'accountId'=${accountId} AND value->>'status'='published' ORDER BY COALESCE((value->>'publishedAt')::timestamptz,(value->>'scheduledAt')::timestamptz) DESC LIMIT 200`;
    const counts=new Map();for(const r of rows){const t=r.value.publishedAt||r.value.scheduledAt,h=offsetHour(t,offset);counts.set(h,(counts.get(h)||0)+1);}bestHours=[...counts].map(([hour,posts])=>({hour,posts,avgScore:posts,label:fmtHour(hour)})).sort((a,b)=>b.posts-a.posts).slice(0,3);source='published_history_fallback';
  }
  if(!bestHours.length){ bestHours=[12,18,21].map((hour,i)=>({hour,posts:0,avgScore:0,label:fmtHour(hour),rank:i+1}));source='default_fallback'; }
  const result={ok:true,accountId,label:account.label,igUserId:account.igUserId,fetchedAt:new Date().toISOString(),source,apiError,bestHours,items,topPost:items[0]||null};
  cache[accountId]=result; await stateSet(env,PERF_CACHE_KEY,cache); return result;
}
async function bestTimesResponse(url,env){
  const ids=String(url.searchParams.get('accountIds')||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,15), offset=Math.max(-840,Math.min(840,Number(url.searchParams.get('tzOffsetMinutes')||330))), force=url.searchParams.get('refresh')==='1';
  const accounts=await getAccounts(env), use=ids.length?ids:accounts.map(a=>a.id); const out=[];
  for(const id of use){ try{const p=await getPerformance(env,id,offset,force);out.push({accountId:id,label:p.label,source:p.source,bestHours:p.bestHours});}catch(e){const a=accounts.find(x=>x.id===id);out.push({accountId:id,label:a?.label||id,source:'error_fallback',error:e.message,bestHours:[12,18,21].map(hour=>({hour,label:fmtHour(hour)}))});} }
  return j({ok:true,tzOffsetMinutes:offset,accounts:out});
}

async function duplicatesCheck(request,env){
  const b=await request.json().catch(()=>({})), accountIds=[...new Set((b.accountIds||[]).map(String))].slice(0,15), files=Array.isArray(b.files)?b.files.slice(0,100):[];
  const duplicates=await findDuplicates(env,accountIds,files); return j({ok:true,duplicates,count:duplicates.length});
}
async function findDuplicates(env,accountIds,files){
  if(!accountIds.length||!files.length) return [];
  const fps=[...new Set(files.map(f=>String(f.fingerprint||'').trim()).filter(Boolean))]; if(!fps.length)return[];
  const rows=await db(env)`SELECT value FROM jobs_state WHERE value->>'accountId' IN (SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)) AND value->>'fingerprint' IN (SELECT jsonb_array_elements_text(${JSON.stringify(fps)}::jsonb)) AND value->>'status'<>'failed'`;
  const duplicates=[];for(const r of rows){const v=r.value;duplicates.push({fingerprint:v.fingerprint,accountId:v.accountId,accountLabel:v.accountLabel,fileName:v.fileName,status:v.status,scheduledAt:v.scheduledAt,publishedAt:v.publishedAt||null,jobId:v.id});}return duplicates;
}

async function scheduleDirectEnhanced(request,env,ctx){
  const body=await request.json().catch(()=>({})), files=Array.isArray(body.files)?body.files:[], cfg={...(body.config||{})};
  const accountIds=(cfg.accountIds||[]).map(String);
  if(cfg.duplicateProtection!==false&&!cfg.duplicateOverride){
    const duplicates=await findDuplicates(env,accountIds,files);
    if(duplicates.length) return j({ok:false,code:'DUPLICATE_VIDEO',error:`Duplicate video blocked: ${duplicates.length} matching scheduled/published item(s). Turn Duplicate Protection off only if you intentionally want to repost.`,duplicates},409);
  }
  const clientBatchId=String(cfg.batchId||crypto.randomUUID());
  const chunkHash=(await hashText(files.map(f=>`${f.fileId||''}:${f.fingerprint||''}:${f.name||''}`).join('|'))).slice(0,16);
  cfg.clientBatchId=clientBatchId; cfg.batchId=`${clientBatchId}_${chunkHash}`;
  let appendInfo={shiftedAccounts:0,shiftedJobs:0};
  if(cfg.appendExisting!==false&&cfg.mode==='explicit'&&Array.isArray(cfg.explicitTimes)&&accountIds.length){
    const adjusted=await appendExplicitTimes(env,accountIds,cfg.explicitTimes,Number(cfg.appendGapMinutes||10));cfg.explicitTimes=adjusted.times;appendInfo=adjusted.info;
  }
  const fwdHeaders=new Headers(request.headers);fwdHeaders.delete('content-length');
  const forwarded=new Request(request.url,{method:'POST',headers:fwdHeaders,body:JSON.stringify({...body,config:cfg})});
  const res=await baseWorker.fetch(forwarded,env,ctx); const data=await res.clone().json().catch(()=>null);
  if(res.ok&&data&&Number(data.created||0)>0){
    const rows=await db(env)`SELECT value FROM jobs_state WHERE value->>'batchId'=${cfg.batchId}`; const map=new Map(files.map(f=>[String(f.name||''),f])),controls=await getControls(env),far=10*365*24*60*60*1000; const jobs=rows.map(r=>{const v=r.value,f=map.get(String(v.fileName||''));if(f){v.fingerprint=String(f.fingerprint||'')||null;v.fileSize=Number(f.size||0)||null;v.fileLastModified=Number(f.lastModified||0)||null;v.clientBatchId=clientBatchId;v.appendExisting=cfg.appendExisting!==false;v.duplicateProtection=cfg.duplicateProtection!==false;}if(controls[v.accountId]?.paused){const t=new Date(v.scheduledAt).getTime();v.accountPauseOriginalScheduledAt=v.scheduledAt;v.scheduledAt=new Date((Number.isFinite(t)?t:Date.now())+far).toISOString();v.accountPaused=true;v.accountPausedAt=controls[v.accountId].pausedAt||new Date().toISOString();}return v;}); if(jobs.length)await upsertJobs(env,jobs);
  }
  if(!data) return res;
  return j({...data,clientBatchId,effectiveBatchId:cfg.batchId,appendInfo,duplicateProtection:cfg.duplicateProtection!==false},res.status);
}
async function appendExplicitTimes(env,accountIds,times,gapMinutes){
  const count=accountIds.length; if(!count||times.length%count!==0)return{times,info:{shiftedAccounts:0,shiftedJobs:0}};
  const rows=await db(env)`SELECT value FROM jobs_state WHERE value->>'accountId' IN (SELECT jsonb_array_elements_text(${JSON.stringify(accountIds)}::jsonb)) AND value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait')`;
  const latest=new Map();
  for(const r of rows){const v=r.value,t=new Date(v.accountPauseOriginalScheduledAt||v.scheduledAt).getTime();if(Number.isFinite(t))latest.set(v.accountId,Math.max(latest.get(v.accountId)||0,t));}
  const out=times.slice(), gap=Math.max(1,gapMinutes)*60000; let shiftedAccounts=0,shiftedJobs=0;
  for(let ai=0;ai<count;ai++){
    const idx=[];for(let i=ai;i<out.length;i+=count)idx.push(i);if(!idx.length)continue;
    const first=new Date(out[idx[0]]).getTime(),last=latest.get(accountIds[ai])||0;if(!Number.isFinite(first)||!last)continue;
    const target=last+gap;if(first<target){const delta=target-first;for(const i of idx){const t=new Date(out[i]).getTime();if(Number.isFinite(t))out[i]=new Date(t+delta).toISOString();}shiftedAccounts++;shiftedJobs+=idx.length;}
  }
  return{times:out,info:{shiftedAccounts,shiftedJobs}};
}
