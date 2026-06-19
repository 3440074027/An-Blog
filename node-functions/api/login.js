import {
  json,
  readJsonBody,
  getUser,
  verifyPassword,
  createToken,
  publicUser
} from './_lib/auth.js';

export async function onRequestPost(context){
  try{
    const body = await readJsonBody(context.request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if(!username){
      return json({ error:'请输入用户名。' }, 400);
    }
    if(!password){
      return json({ error:'请输入密码。' }, 400);
    }

    // 这里 getUser 已经做了大小写不敏感兜底
    const user = await getUser(username);
    if(!user){
      return json({ error:'用户不存在，请先注册。' }, 404);
    }
    if(!verifyPassword(password, user.password)){
      return json({ error:'密码错误，请重新输入。' }, 401);
    }

    // 注意：登录成功不再回写整个用户记录，避免无谓 bump 版本与 Redis 写失败导致登录失败。
    return json({
      ok:true,
      token:createToken(user.username),
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
