import { json, getRequestUrl, getUser, publicUser } from '../_lib/auth.js';

export async function onRequestGet(context){
  try{
    const url = getRequestUrl(context.request);
    const username = String(url.searchParams.get('username') || '').trim();
    if(!username){
      return json({ error:'缺少用户名。' }, 400);
    }
    const user = await getUser(username);
    if(!user){
      return json({ error:'用户不存在。' }, 404);
    }
    return json({ ok:true, user:publicUser(user) });
  }catch(error){
    console.error('user profile error:', error);
    return json({ error:'获取用户资料失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 请求。' }, 405);
}
