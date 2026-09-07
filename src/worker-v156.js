import priorWorker from './worker-v155.js';
import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return priorWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return health156(request, env, ctx);
      return priorWorker.fetch(request, env, ctx);
    } catch (e) {
      return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async()=>{
      try { await protectActionLimitedAccounts(env); } catch (e) { console.error('action-limit-protection', e?.stack || e); }
      await priorWorker.scheduled(controller, env, ctx);
    })());
  }
};

function db(env){
  if(!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured in Cloudflare');
  return neon(env.DATABASE_URL);
}
function envNum(env,key,def){const n=Number(env[key]);return Number.isFinite(n)?n:def}
function burstOffset(index,size=5,gap=10,br=60){const group=Math.floor(index/size),within=index%size;return (group*((size-1)*gap+br)+within*gap)*60000}
function isActionLimitMessage(v){const s=String(v||'').toLowerCase();return s.includes('user is performing too many actions')||s.includes('too many actions')||s.includes('temporarily blocked from taking this action')||s.includes('please try again later')}

async function protectActionLimitedAccounts(env){
  const sql=db(env), now=Date.now();
  const backoff=Math.max(15,envNum(env,'META_ACTION_LIMIT_BACKOFF_MINUTES',60))*60000;
  const size=Math.max(1,envNum(env,'SCHEDULER_BURST_SIZE',5));
  const gap=Math.max(1,envNum(env,'SCHEDULER_BURST_GAP_MINUTES',10));
  const br=Math.max(gap,envNum(env,'SCHEDULER_BURST_BREAK_MINUTES',60));

  const hits=await sql`SELECT value FROM jobs_state WHERE value->>'status'='retry_wait' AND (LOWER(COALESCE(value->>'error','')) LIKE '%too many actions%' OR LOWER(COALESCE(value->>'error','')) LIKE '%temporarily blocked from taking this action%' OR LOWER(COALESCE(value->>'error','')) LIKE '%please try again later%') ORDER BY updated_at DESC LIMIT 20`;
  const seen=new Set();
  for(const row of hits){
    const hit=row.value||{}, accountId=String(hit.accountId||'');
    if(!accountId||seen.has(accountId)||!isActionLimitMessage(hit.error)) continue;
    seen.add(accountId);
    const handledAt=new Date(hit.actionLimitHandledAt||0).getTime();
    if(Number.isFinite(handledAt)&&now-handledAt<backoff/2) continue;

    const cooldownUntil=now+backoff;
    const rows=await sql`SELECT value FROM jobs_state WHERE value->>'accountId'=${accountId} AND value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait') ORDER BY COALESCE((value->>'scheduledAt')::timestamptz,NOW()) ASC`;
    const jobs=rows.map(r=>r.value).filter(Boolean);
    let idx=0;
    for(const j of jobs){
      if(String(j.id)===String(hit.id)){
        j.lastErrorType='rate_limit';
        j.actionLimitHandledAt=new Date(now).toISOString();
        j.actionLimitCooldownUntil=new Date(cooldownUntil).toISOString();
        j.nextAttemptAt=new Date(cooldownUntil).toISOString();
        continue;
      }
      const t=new Date(j.scheduledAt).getTime();
      if(!Number.isFinite(t)||t<cooldownUntil){
        j.scheduledAt=new Date(cooldownUntil+60000+burstOffset(idx++,size,gap,br)).toISOString();
        j.rateLimitRebasedAt=new Date(now).toISOString();
        j.rateLimitReason='meta_too_many_actions';
        if(['processing','ready'].includes(j.status)){
          j.status='scheduled';j.containerId=null;j.preparedAt=null;j.readyAt=null;j.nextAttemptAt=null;
        }
      }
    }
    if(jobs.length){
      await sql`INSERT INTO jobs_state(id,value,updated_at) SELECT x->>'id',x,NOW() FROM jsonb_array_elements(${JSON.stringify(jobs)}::jsonb) x ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`;
    }
  }
}

async function health156(request,env,ctx){
  const r=await priorWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);if(!x)return r;
  return Response.json({...x,version:'15.6.0',features:{...(x.features||{}),metaActionLimitProtection:true,accountCooldownOnTooManyActions:true}},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
}
