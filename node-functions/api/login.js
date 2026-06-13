import {
  json,
  readJsonBody,
  getUser,
  setUser,
  verifyPassword,
  createToken,
  publicUser
} from './_lib/auth.js';

export async function onRequestPost(context){
  try{
    const body = await readJsonBody(context.request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    const user = await getUser(username);
    if(!user){
      return json({ error:'用户不存在，请先注册。' }, 404);
    }
    if(!verifyPassword(password, user.password)){
      return json({ error:'密码错误，请重新输入。' }, 401);
    }
    await setUser(user);

    return json({
      ok:true,
      token:createToken(username),
      user:publicUser(user)
    });
  }catch(error){
    console.error('login error:', error);
    return json({ error:'登录失败，请稍后再试。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 POST 请求。' }, 405);
}
