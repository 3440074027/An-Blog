import {
  json,
  getRequestUrl,
  verifyToken,
  readVersionFields,
  VERSION_FIELDS
} from './_lib/auth.js';

/*
 * GET /api/site-versions[?username=<u>]
 * 返回若干条内容的当前版本号，前端轮询比较：变了就拉新数据。
 *
 * - announcements / articles 是站点级，所有人可见，不需登录。
 * - user / mail 是用户级：用 Authorization 或 ?username= 解析当前账号。
 *
 * 所有版本号集中放在一个 HASH（db:versions）里，一次 HMGET 拉完。
 */
export async function onRequestGet(context){
  try{
    const url = getRequestUrl(context.request);
    const authorization = context.request.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const tokenUsername = token ? verifyToken(token) : '';
    const queryUsername = String(url.searchParams.get('username') || '').trim();
    const username = tokenUsername || queryUsername;

    const fields = [VERSION_FIELDS.announcements, VERSION_FIELDS.articles];
    if(username){
      fields.push(VERSION_FIELDS.user(username));
      fields.push(VERSION_FIELDS.mail(username));
    }
    const values = await readVersionFields(fields);

    const result = {
      announcements: values[0] || 0,
      articles: values[1] || 0
    };
    if(username){
      result.user = values[2] || 0;
      result.mail = values[3] || 0;
      result.username = username;
    }
    return json({ ok:true, versions:result, ts:Date.now() });
  }catch(error){
    console.error('site-versions error:', error);
    return json({ error:'读取版本失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 请求。' }, 405);
}
