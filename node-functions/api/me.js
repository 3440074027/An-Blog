import { json, requireUser, publicUser } from './_lib/auth.js';

export async function onRequestGet(context){
  const result = await requireUser(context.request);
  if(result.error){
    return json({ error:result.error }, result.status);
  }
  return json({ ok:true, user:publicUser(result.user) });
}

export function onRequest(){
  return json({ error:'只支持 GET 请求。' }, 405);
}
