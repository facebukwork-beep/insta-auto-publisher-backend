import smartWorker from './worker-v153.js';
import { neon } from '@neondatabase/serverless';

const DELETE_API_VERSION = 'v25.0';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return smartWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return health154(request, env, ctx);
      if (url.pathname === '/api/instagram/posts' && request.method === 'GET') return listInstagramPosts(url, env);
      const m = url.pathname.match(/^\/api\/instagram\/posts\/([^/]+)$/);
      if (m && request.method === 'DELETE') return deleteInstagramPost(url, env, decodeURIComponent(m[1]));
      return smartWorker.fetch(request, env, ctx);
    } catch (e) {
      return json({ ok:false, error:String(e?.message || e) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    return smartWorker.scheduled(controller, env, ctx);
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
function db(env){
  if(!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured in Cloudflare');
  return neon(env.DATABASE_URL);
}
async function stateGet(env,key){const r=await db(env)`SELECT value FROM app_state WHERE key=${key}`;return r[0]?.value??null;}
async function stateSet(env,key,value){await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`;}
async function getAccounts(env){const v=await stateGet(env,'accounts');return Array.isArray(v)?v:[];}
function graphVersion(env){return String(env.GRAPH_API_VERSION||'v23.0').trim();}
function hex(bytes){return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');}
function unhex(s){if(!s||s.length%2)throw new Error('Invalid encrypted payload');const out=new Uint8Array(s.length/2);for(let i=0;i<out.length;i++)out[i]=parseInt(s.slice(i*2,i*2+2),16);return out;}
async function secretKey(env){
  if(!env.APP_SECRET_KEY)throw new Error('APP_SECRET_KEY is not configured in Cloudflare');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.APP_SECRET_KEY));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt']);
}
async function decrypt(env,payload){
  const [ivh,tagh,datah]=String(payload||'').split('.');
  if(!ivh||!tagh||datah===undefined)throw new Error('Encrypted payload is invalid');
  const key=await secretKey(env),iv=unhex(ivh),tag=unhex(tagh),data=unhex(datah),all=new Uint8Array(data.length+tag.length);
  all.set(data);all.set(tag,data.length);
  const out=await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,all);
  return new TextDecoder().decode(out);
}
async function graphGet(env,path,params,token){
  const u=new URL(`https://graph.instagram.com/${graphVersion(env)}/${path}`);
  for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));
  u.searchParams.set('access_token',token);
  const r=await fetch(u);const x=await r.json().catch(()=>({}));
  if(!r.ok||x.error)throw new Error(x.error?.message||`Meta API HTTP ${r.status}`);
  return x;
}
async function deleteAt(host,version,mediaId,token){
  const u=new URL(`https://${host}/${version}/${encodeURIComponent(mediaId)}`);
  u.searchParams.set('access_token',token);
  const r=await fetch(u,{method:'DELETE'});const x=await r.json().catch(()=>({}));
  return {ok:r.ok&&!x.error,status:r.status,data:x,error:x.error?.message||(!r.ok?`HTTP ${r.status}`:null)};
}

async function health154(request,env,ctx){
  const r=await smartWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);
  if(!x)return r;
  return json({...x,version:'15.4.0',features:{...(x.features||{}),instagramPostManager:true,instagramPostDelete:true}});
}

async function listInstagramPosts(url,env){
  const accountId=String(url.searchParams.get('accountId')||'');
  const limit=Math.max(1,Math.min(50,Number(url.searchParams.get('limit')||25)));
  if(!accountId)return json({error:'accountId is required'},400);
  const account=(await getAccounts(env)).find(a=>String(a.id)===accountId);
  if(!account)return json({error:'Connected account not found'},404);
  const token=await decrypt(env,account.tokenEnc);
  const x=await graphGet(env,`${account.igUserId}/media`,{fields:'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username',limit},token);
  const posts=(Array.isArray(x.data)?x.data:[]).map(p=>({
    id:String(p.id),caption:String(p.caption||''),mediaType:p.media_type||p.media_product_type||null,
    mediaUrl:p.media_url||null,thumbnailUrl:p.thumbnail_url||null,permalink:p.permalink||null,
    timestamp:p.timestamp||null,likes:Number(p.like_count||0),comments:Number(p.comments_count||0),username:p.username||account.label
  }));
  return json({ok:true,accountId:account.id,label:account.label,igUserId:account.igUserId,count:posts.length,posts,next:x.paging?.next||null});
}

async function deleteInstagramPost(url,env,mediaId){
  const accountId=String(url.searchParams.get('accountId')||'');
  const confirm=String(url.searchParams.get('confirm')||'');
  if(!accountId)return json({error:'accountId is required'},400);
  if(confirm!=='DELETE')return json({error:'Deletion confirmation is required'},400);
  const account=(await getAccounts(env)).find(a=>String(a.id)===accountId);
  if(!account)return json({error:'Connected account not found'},404);
  const token=await decrypt(env,account.tokenEnc);

  // Safety gate: only allow a media id returned from this connected account's own recent media edge.
  const own=await graphGet(env,`${account.igUserId}/media`,{fields:'id',limit:100},token);
  if(!(own.data||[]).some(p=>String(p.id)===String(mediaId)))return json({error:'This media was not found on the selected connected Instagram account.'},404);

  const version=String(env.INSTAGRAM_DELETE_API_VERSION||DELETE_API_VERSION).trim();
  let result=await deleteAt('graph.instagram.com',version,mediaId,token);
  let host='graph.instagram.com';
  if(!result.ok){
    const fallback=await deleteAt('graph.facebook.com',version,mediaId,token);
    if(fallback.ok){result=fallback;host='graph.facebook.com';}
    else{
      const msg=[result.error,fallback.error].filter(Boolean).join(' / ');
      const permission=/permission|manage_contents|unsupported|method|oauth/i.test(msg);
      return json({ok:false,error:permission?'Meta did not allow deletion with this token. Reconnect/generate the account token with Instagram content-management permission (instagram_manage_contents) and try again.':`Instagram delete failed: ${msg}`,meta:{instagramHostError:result.error,facebookHostError:fallback.error,apiVersion:version}},permission?403:502);
    }
  }

  const now=new Date().toISOString();
  await db(env)`UPDATE jobs_state SET value=value || ${JSON.stringify({instagramDeleted:true,instagramDeletedAt:now})}::jsonb,updated_at=NOW() WHERE value->>'publishedMediaId'=${String(mediaId)}`;
  const cache=(await stateGet(env,'performance_cache_v1'))||{};
  if(cache&&typeof cache==='object'&&cache[accountId]){delete cache[accountId];await stateSet(env,'performance_cache_v1',cache);}
  return json({ok:true,deleted:true,mediaId:String(mediaId),accountId:account.id,label:account.label,host,apiVersion:version,result:result.data});
}
