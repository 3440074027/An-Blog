import {
  json,
  readJsonBody,
  requireUser,
  verifyPassword,
  isValidUsername,
  isValidPassword,
  userExists,
  hashPassword,
  renameUser,
  setUser,
  deleteUser,
  createToken,
  publicUser,
  nowIso
} from './_lib/auth.js';

async function requireVerifiedAccount(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return { response:json({ error:auth.error }, auth.status) };
  }
  const body = await readJsonBody(context.request);
  const currentPassword = String(body.currentPassword || '');
  if(!verifyPassword(currentPassword, auth.user.password)){
    return { response:json({ error:'当前密码错误，请重新验证。' }, 401) };
  }
  return { user:auth.user, body };
}

export async function onRequestPost(context){
  const result = await requireVerifiedAccount(context);
  if(result.response) return result.response;
  return json({ ok:true, verified:true });
}

export async function onRequestPut(context){
  const result = await requireVerifiedAccount(context);
  if(result.response) return result.response;

  try{
    const user = result.user;
    const body = result.body;
    const nextUsername = String(body.username || user.username).trim();
    const nextPassword = String(body.newPassword || '');

    if(!isValidUsername(nextUsername)){
      return json({ error:'用户名只能由字母和数字组成，长度 2 到 20 位。' }, 400);
    }
    if(nextPassword && !isValidPassword(nextPassword)){
      return json({ error:'新密码长度需为 6 到 64 位，只能使用数字、大小写字母和 !@#$%^&*_-+=.? 这些基础符号。' }, 400);
    }

    if(nextUsername !== user.username){
      const exists = await userExists(nextUsername);
      if(exists){
        return json({ error:'这个用户名已经被注册。' }, 409);
      }
      await renameUser(user, nextUsername);
    }

    if(nextPassword){
      user.password = hashPassword(nextPassword);
      user.updatedAt = nowIso();
      await setUser(user);
    }

    return json({
      ok:true,
      token:createToken(user.username),
      user:publicUser(user)
    });
  }catch(error){
    console.error('account update error:', error);
    return json({ error:'账号信息修改失败，请稍后再试。' }, 500);
  }
}

export async function onRequestDelete(context){
  const result = await requireVerifiedAccount(context);
  if(result.response) return result.response;

  try{
    await deleteUser(result.user.username);
    return json({ ok:true, deleted:true });
  }catch(error){
    console.error('account delete error:', error);
    return json({ error:'注销账号失败，请稍后再试。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 POST、PUT 或 DELETE 请求。' }, 405);
}
