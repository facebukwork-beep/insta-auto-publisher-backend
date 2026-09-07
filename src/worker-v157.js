import priorWorker from './worker-v156.js';
import { neon } from '@neondatabase/serverless';

const GLOBAL_KEY='meta_global_action_cooldown_v1';

export default {
  async fetch(request,env,ctx){
    if(request.method==='OPTIONS') return priorWorker.fetch(request,env,ctx);
    try{
      const url=new URL(request.url);
      if(url.pathname==='/api/health'&&request.method==='GET') return health157(request,env,ctx);
      if(url.pathname==='/api/meta-throttle/status'&&request.method==='GET') return throttleStatus(env);
      return priorWorker.fetch(request,env,ctx);
    }catch(e){return Response.json({ok:false,error:String(e?.message||e)},{status:500,headers:{'access-control-allow-origin':'*','cache-control':'no-store'}})}
  },
  async scheduled(controller,env,ctx){
    ctx.waitUntil((async()=>{
      const ctl=await detectAndUpdateGlobalCooldown(env).catch(e=>{console.error('global-action-cooldown',e?.stack||e);return null});
      if(ctl?.active){
        console.log('Meta global cooldown active until',ctl.until);
        return;
      }
      priorWorker.scheduled(controller,env,ctx);
    })());
  }
};

function db(env){if(!env.DATABASE_URL)throw new Error('DATABASE_URL is not configured in Cloudflare');return neon(env.DATABASE_URL)}
function envNum(env,key,def){const n=Number(env[key]);return Number.isFinite(n)?n:def}
async function stateGet(env,key){const r=await db(env)`SELECT value FROM app_state WHERE key=${key}`;return r[0]?.value??null}
async function stateSet(env,key,value){await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`}

async function detectAndUpdateGlobalCooldown(env){
  const sql=db(env),now=Date.now(),windowMin=Math.max(5,envNum(env,'META_GLOBAL_ACTION_WINDOW_MINUTES',20));
  const rows=await sql`SELECT value,updated_at FROM jobs_state WHERE updated_at > NOW()-(${windowMin}::text || ' minutes')::interval AND value->>'status'='retry_wait' AND (LOWER(COALESCE(value->>'error','')) LIKE '%too many actions%' OR LOWER(COALESCE(value->>'error','')) LIKE '%temporarily blocked from taking this action%' OR LOWER(COALESCE(value->>'error','')) LIKE '%please try again later%') ORDER BY updated_at DESC LIMIT 100`;
  const accountIds=[...new Set(rows.map(r=>String(r.value?.accountId||'')).filter(Boolean))];
  let ctl=(await stateGet(env,GLOBAL_KEY))||{until:null,lastEventAt:null,strikes:0,accounts:[]};
  const newest=rows[0]?.updated_at?new Date(rows[0].updated_at).getTime():0;
  const previousEvent=new Date(ctl.lastEventAt||0).getTime();

  if(accountIds.length>=2&&newest>previousEvent){
    const strikes=Math.min(4,Math.max(1,Number(ctl.strikes||0)+1));
    const base=Math.max(30,envNum(env,'META_GLOBAL_ACTION_BACKOFF_MINUTES',90));
    const minutes=Math.min(360,base*Math.pow(1.5,strikes-1));
    ctl={until:new Date(now+minutes*60000).toISOString(),lastEventAt:new Date(newest).toISOString(),updatedAt:new Date(now).toISOString(),strikes,accounts:accountIds,reason:'multiple_accounts_too_many_actions',minutes:Math.round(minutes)};
    await stateSet(env,GLOBAL_KEY,ctl);
  }

  const until=new Date(ctl.until||0).getTime();
  if(Number.isFinite(until)&&until>now) return {...ctl,active:true,remainingMinutes:Math.ceil((until-now)/60000)};

  if(ctl.until&&until<=now&&Number(ctl.strikes||0)>0){
    ctl={...ctl,until:null,updatedAt:new Date(now).toISOString(),strikes:Math.max(0,Number(ctl.strikes||0)-1)};
    await stateSet(env,GLOBAL_KEY,ctl);
  }
  return {...ctl,active:false,remainingMinutes:0};
}

async function throttleStatus(env){
  const ctl=await detectAndUpdateGlobalCooldown(env);
  return Response.json({ok:true,...ctl},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
}

async function health157(request,env,ctx){
  const r=await priorWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);if(!x)return r;
  const ctl=await detectAndUpdateGlobalCooldown(env).catch(()=>null);
  return Response.json({...x,version:'15.7.0',metaThrottle:ctl?{active:!!ctl.active,until:ctl.until||null,remainingMinutes:ctl.remainingMinutes||0,accounts:ctl.accounts||[]}:null,features:{...(x.features||{}),adaptiveGlobalMetaCooldown:true,multiAccountActionLimitProtection:true}},{headers:{'access-control-allow-origin':'*','cache-control':'no-store'}});
}
