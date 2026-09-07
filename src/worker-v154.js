import smartWorker from './worker-v153.js';
import { neon } from '@neondatabase/serverless';

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return smartWorker.fetch(request, env, ctx);
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/health' && request.method === 'GET') return health154(request, env, ctx);
      if (url.pathname === '/api/instagram/posts' && request.method === 'GET') return listInstagramPosts(url, env);
      const m = url.pathname.match(/^\/api\/instagram\/posts\/([^/]+)$/);
      if (m && request.method === 'DELETE') return manualDeleteInfo(url, env, decodeURIComponent(m[1]));
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
async function getAccounts(env){const v=await stateGet(env,'accounts');return Array.isArray(v)?v:[];}
function graphVersion(env){return String(env.GRAPH_API_VERSION||'v23.0').trim();}
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

async function health154(request,env,ctx){
  const r=await smartWorker.fetch(request,env,ctx);const x=await r.clone().json().catch(()=>null);
  if(!x)return r;
  return json({...x,version:'15.4.1',features:{...(x.features||{}),instagramPostManager:true,instagramPostDelete:false,instagramOpenToDelete:true}});
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
    timestamp:p.timestamp||null,likes:Number(p.like_count||0),comments:Number(p.comments_count||0),username:p.username||account.label,
    deleteMode:'open_in_instagram'
  }));
  return json({ok:true,accountId:account.id,label:account.label,igUserId:account.igUserId,count:posts.length,posts,next:x.paging?.next||null,directDeleteSupported:false,note:'Instagram Graph API does not provide an endpoint to delete published media. Open the post in Instagram to delete it.'});
}

async function manualDeleteInfo(url,env,mediaId){
  const accountId=String(url.searchParams.get('accountId')||'');
  if(!accountId)return json({error:'accountId is required'},400);
  const account=(await getAccounts(env)).find(a=>String(a.id)===accountId);
  if(!account)return json({error:'Connected account not found'},404);
  const token=await decrypt(env,account.tokenEnc);
  const own=await graphGet(env,`${account.igUserId}/media`,{fields:'id,permalink',limit:100},token);
  const item=(own.data||[]).find(p=>String(p.id)===String(mediaId));
  if(!item)return json({error:'This media was not found on the selected connected Instagram account.'},404);
  return json({ok:false,directDeleteSupported:false,manualDeleteRequired:true,mediaId:String(mediaId),accountId:account.id,permalink:item.permalink||null,error:'Instagram does not support deleting published media through the official API. Open this post in Instagram and delete it there.'},405);
}
