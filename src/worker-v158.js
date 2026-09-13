import priorWorker from './worker-v155.js';
import { neon } from '@neondatabase/serverless';

const RECOVERY_KEY='v158_stale_action_limit_recovery';

export default {
  async fetch(request,env,ctx){
    if(request.method==='OPTIONS') return priorWorker.fetch(request,env,ctx);
    try{
      const url=new URL(request.url);
      if(url.pathname==='/api/health'&&request.method==='GET') return health158(request,env,ctx);
      if(url.pathname==='/api/recovery/status'&&request.method==='GET') return recoveryStatus(env);
      return priorWorker.fetch(request,env,ctx);
    }catch(e){
      return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
    }
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil((async()=>{
      try{await recoverStaleJobs(env)}catch(e){console.error('v158-recovery',e?.stack||e)}
      await priorWorker.scheduled(controller,env,ctx);
    })());
  }
};

function db(env){
  if(!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured in Cloudflare');
  return neon(env.DATABASE_URL);
}
async function stateGet(env,key){const r=await db(env)`SELECT value FROM app_state WHERE key=${key}`;return r[0]?.value??null}
async function stateSet(env,key,value){await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`}
function burstOffset(i){const size=5,gap=10,br=60,group=Math.floor(i/size),within=i%size;return (group*((size-1)*gap+br)+within*gap)*60000}

async function recoverStaleJobs(env){
  const done=await stateGet(env,RECOVERY_KEY);
  if(done?.done) return done;
  const sql=db(env), now=Date.now();
  const rows=await sql`SELECT value FROM jobs_state WHERE value->>'status' IN ('scheduled','processing','ready','retry_wait') ORDER BY COALESCE((value->>'scheduledAt')::timestamptz,NOW()) ASC`;
  const jobs=rows.map(r=>r.value).filter(Boolean);
  const byAccount=new Map();
  for(const j of jobs){
    const s=String(j.error||'').toLowerCase();
    const staleMeta=Boolean(j.actionLimitHandledAt||j.actionLimitCooldownUntil||j.rateLimitReason||j.rateLimitRebasedAt);
    const tooMany=s.includes('too many actions')||s.includes('temporarily blocked from taking this action')||s.includes('please try again later');
    const due=new Date(j.scheduledAt||0).getTime();
    const next=new Date(j.nextAttemptAt||0).getTime();
    const last=new Date(j.lastAttemptAt||0).getTime();
    const oldAttempt=Number.isFinite(last)&&last>0&&now-last>2*60*60*1000;
    const overdue=Number.isFinite(due)&&due<now;
    const trapped=Number.isFinite(next)&&next>now+2*60*60*1000;
    if((tooMany&&oldAttempt)||(staleMeta&&(overdue||trapped))){
      const aid=String(j.accountId||'');
      if(!byAccount.has(aid))byAccount.set(aid,[]);
      byAccount.get(aid).push(j);
    }
  }
  let changed=0;
  for(const [aid,list] of byAccount){
    const start=now+120000;
    list.sort((a,b)=>new Date(a.scheduledAt||0)-new Date(b.scheduledAt||0));
    list.forEach((j,i)=>{
      j.scheduledAt=new Date(start+burstOffset(i)).toISOString();
      j.status=j.containerId?'processing':'scheduled';
      j.nextAttemptAt=null;
      j.retryCount=0;
      j.lastErrorType=null;
      j.error=null;
      delete j.actionLimitHandledAt;
      delete j.actionLimitCooldownUntil;
      delete j.actionLimitRecoveryReleasedAt;
      delete j.rateLimitReason;
      delete j.rateLimitRebasedAt;
      j.v158RecoveredAt=new Date().toISOString();
      changed++;
    });
    if(list.length){
      await sql`INSERT INTO jobs_state(id,value,updated_at) SELECT x->>'id',x,NOW() FROM jsonb_array_elements(${JSON.stringify(list)}::jsonb) x ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`;
    }
  }
  const result={done:true,changed,accounts:[...byAccount.keys()].filter(Boolean),doneAt:new Date().toISOString()};
  await stateSet(env,RECOVERY_KEY,result);
  return result;
}

async function recoveryStatus(env){
  const x=(await stateGet(env,RECOVERY_KEY))||{done:false,changed:0,accounts:[]};
  return Response.json({ok:true,...x},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
}

async function health158(request,env,ctx){
  const r=await priorWorker.fetch(request,env,ctx);
  const x=await r.clone().json().catch(()=>null);
  if(!x)return r;
  const rec=(await stateGet(env,RECOVERY_KEY))||null;
  return Response.json({...x,version:'15.8.0',recovery:rec,features:{...(x.features||{}),stableSchedulerRestore:true,staleActionLimitRecovery:true,globalSchedulerBlockRemoved:true}},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
}
