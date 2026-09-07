import postWorker from './worker-v154.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return postWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return health155(request, env, ctx);
      if (url.pathname === '/api/dispute-helper/draft' && request.method === 'POST') return makeDraft(request);
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

async function health155(request,env,ctx){
  const r=await postWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);
  if(!x)return r;
  return json({...x,version:'15.5.0',features:{...(x.features||{}),disputeHelper:true,autoDisputeSubmission:false}});
}

function clean(v,max=1200){return String(v||'').replace(/\s+/g,' ').trim().slice(0,max)}
function basisLabel(v){
  return ({original:'I created and own the material',licensed:'I have a valid license to use the material',permission:'I have permission from the rights holder',public_domain:'The material is in the public domain',misidentification:'The claim appears to identify the wrong material',other:'I have another legitimate rights basis'})[v]||'I have a legitimate rights basis';
}
function evidenceLine(b){
  if(b==='original')return 'I can provide original source files, project files, timestamps, or other creation records if needed.';
  if(b==='licensed')return 'I can provide the relevant license, invoice, receipt, or licensing terms if needed.';
  if(b==='permission')return 'I can provide written permission or authorization from the rights holder if needed.';
  if(b==='public_domain')return 'I can provide the source and documentation supporting the public-domain status if needed.';
  if(b==='misidentification')return 'I can provide source material and comparison details showing why the claimed work does not match my post.';
  return 'I can provide supporting documentation for my rights basis if needed.';
}

async function makeDraft(request){
  const b=await request.json().catch(()=>({}));
  if(b.confirmedRights!==true)return json({ok:false,error:'Please confirm that you have a genuine rights/permission basis before generating a dispute draft.'},400);
  const claimant=clean(b.claimant,200),notice=clean(b.notice,500),post=clean(b.postDescription,500),evidence=clean(b.evidence,1000),basis=clean(b.rightsBasis,50)||'other',account=clean(b.accountLabel,120),name=clean(b.name,120);
  if(!post&&!notice)return json({ok:false,error:'Add the blocked-post description or the claim/notice details first.'},400);
  const subject=`Request for review of copyright restriction${account?` on @${account}`:''}`;
  const lines=[
    'Hello Meta/Instagram Review Team,',
    '',
    `I am requesting a review of the copyright restriction on ${post||'my Instagram post'}.`,
    claimant?`The notice/claim identifies ${claimant} as the claimant or rights owner.`:'',
    notice?`Notice details: ${notice}`:'',
    '',
    `${basisLabel(basis)}.`,
    evidenceLine(basis),
    evidence?`Supporting details: ${evidence}`:'',
    '',
    'I am submitting this request in good faith and only on the basis of information I believe to be accurate. Please review the restriction and the supporting rights information. If additional documentation is required, please let me know what is needed.',
    '',
    'Thank you,',
    name||account||'Account owner'
  ].filter(Boolean);
  return json({ok:true,subject,draft:lines.join('\n'),checklist:[
    'Only submit if the rights/permission basis is genuine.',
    'Attach license, written permission, source files, invoices, or other evidence that supports your claim.',
    'Use the exact claimant and notice details shown by Instagram/Meta.',
    'Do not claim ownership, a license, or permission that you do not actually have.',
    'Submit the final dispute through the official Instagram/Meta review flow shown for the affected post or account.'
  ],autoSubmit:false});
}
