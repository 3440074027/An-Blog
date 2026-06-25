import crypto from 'crypto';
import {
  json,
  readJsonBody,
  isValidUsername,
  isValidPassword,
  sanitizeAvatar,
  sanitizeUserProfile,
  hashPassword,
  userExists,
  setUser,
  createToken,
  publicUser,
  nowIso
} from './_lib/auth.js';

export async function onRequestPost(context){
  try{
    const body = await readJsonBody(context.request);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const avatar = sanitizeAvatar(body.avatar);

    if(!isValidUsername(username)){
      return json({ error:'用户名只能由字母和数字组成，长度 2 到 20 位。' }, 400);
    }
    if(!isValidPassword(password)){
      return json({ error:'密码长度需为 6 到 64 位，只能使用数字、大小写字母和 !@#$%^&*_-+=.? 这些基础符号。' }, 400);
    }

    const exists = await userExists(username);
    if(exists){
      return json({ error:'这个用户名已经被注册。' }, 409);
    }

    const createdAt = nowIso();
    const profile = sanitizeUserProfile({ avatar, nickname:username, tags:[] }, username);
    const user = {
      id: crypto.randomUUID(),
      username,
      password: hashPassword(password),
      createdAt,
      updatedAt: createdAt,
      profile
    };
    await setUser(user);

    return json({
      ok:true,
      token:createToken(username),
      user:publicUser(user)
    }, 201);
  }catch(error){
    console.error('register error:', error);
    return json({ error:'注册失败，请稍后再试。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 POST 请求。' }, 405);
}
