import { json, isValidUsername, userExists, getRequestUrl } from './_lib/auth.js';

export async function onRequestGet(context){
  try{
    const url = getRequestUrl(context.request);
    const username = String(url.searchParams.get('username') || '').trim();

    if(!isValidUsername(username)){
      return json({
        ok:false,
        available:false,
        error:'用户名只能由字母和数字组成，长度 2 到 20 位。'
      }, 400);
    }

    // 仅检查“是否被注册”，不读取完整资料 —— 比 getUser 快得多
    const taken = await userExists(username);
    return json({
      ok:true,
      available:!taken
    });
  }catch(error){
    console.error('check-username error:', error);
    return json({ error:'用户名检查失败，请稍后再试。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 请求。' }, 405);
}
