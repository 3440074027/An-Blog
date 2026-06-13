import { json, readJsonBody, requireUser, isSiteOwner, redis, nowIso } from './_lib/auth.js';

const ANNOUNCEMENTS_KEY = 'site:announcements';

const DEFAULT_ANNOUNCEMENTS = [
  { id:'welcome', kicker:'✨ 星尘公告', title:'欢迎来到你的灵感档案馆', body:'这里会收纳文章、文件、灵感和成长记录。每一次登录，都是和未来的自己重逢。' },
  { id:'writing', kicker:'🌙 创作提醒', title:'把今天的想法留下来', body:'一段文字、一张配图、一次复盘，都可以成为下一篇博客的起点。' },
  { id:'roadmap', kicker:'💫 系统计划', title:'文章系统正在扩展', body:'后续会加入文章编辑、文件收纳、分类检索和独立文章详情页。' },
  { id:'profile', kicker:'🫧 温柔提示', title:'资料已和账号绑定', body:'头像、签名、简介和标签都可以同步保存，换设备登录也能继续显示。' },
  { id:'owner', kicker:'💌 站主小纸条', title:'如果迷路了，可以联系站主 An', body:'站主资料卡里会同步 QQ 和邮箱，点击联系站主就能快速查看。' },
  { id:'search', kicker:'🔎 搜索上线', title:'顶部搜索可以查找用户和文章', body:'输入用户名、标签或文章关键词，就能打开公开资料或定位内容。' }
];

function sanitizeAnnouncements(input){
  const source = Array.isArray(input) ? input : [];
  const items = source
    .filter(item => item && typeof item === 'object')
    .slice(0, 12)
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 80) : `notice-${index + 1}`,
      kicker: String(item.kicker || '').trim().slice(0, 60),
      title: String(item.title || '').trim().slice(0, 80),
      body: String(item.body || '').trim().slice(0, 500)
    }))
    .filter(item => item.kicker || item.title || item.body);
  return items.length ? items : DEFAULT_ANNOUNCEMENTS;
}

export async function onRequestGet(){
  try{
    const saved = await redis.get(ANNOUNCEMENTS_KEY);
    return json({ ok:true, announcements:sanitizeAnnouncements(saved || DEFAULT_ANNOUNCEMENTS) });
  }catch(error){
    console.error('announcements get error:', error);
    return json({ ok:true, announcements:DEFAULT_ANNOUNCEMENTS, fallback:true });
  }
}

export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  if(!isSiteOwner(auth.user)){
    return json({ error:'只有站主 An 可以编辑公告栏。' }, 403);
  }
  try{
    const body = await readJsonBody(context.request);
    const announcements = sanitizeAnnouncements(body.announcements);
    await redis.set(ANNOUNCEMENTS_KEY, announcements);
    return json({ ok:true, updatedAt:nowIso(), announcements });
  }catch(error){
    console.error('announcements put error:', error);
    return json({ error:'保存公告失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 或 PUT 请求。' }, 405);
}
