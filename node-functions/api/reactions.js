import { json, readJsonBody, requireUser, redis } from './_lib/auth.js';
import { DB_REACTIONS_HASH } from './_lib/db-keys.js';

/**
 * 文章反应 API（点赞 / 收藏 / 喜欢）
 * --------------------------------------------------
 * 数据存放在 db:reactions HASH，field=articleId，value=JSON：
 *   { likes:[username,...], favorites:[username,...], loves:[username,...] }
 *
 * GET  /api/reactions?articleId=xxx              获取单篇文章所有反应
 * POST /api/reactions                             切换反应（toggle）
 *        body: { articleId, type:"like"|"favorite"|"love" }
 * GET  /api/reactions?username=xxx&articleIds=id1,id2,id3
 *                                                批量获取用户对多篇文章的反应状态
 *        （注意：若需 /api/reactions/user 路径，需额外创建 reactions/user.js）
 */

const VALID_TYPES = new Set(['like', 'favorite', 'love']);

/* ---------- 工具函数 ---------- */

function parseStoredJson(value, fallback){
  if(!value) return fallback;
  if(typeof value === 'object') return value;
  if(typeof value === 'string'){
    try{
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    }catch(_){
      return fallback;
    }
  }
  return fallback;
}

function emptyReactions(){
  return { likes:[], favorites:[], loves:[] };
}

function cleanReactions(data){
  return {
    likes:     Array.isArray(data.likes)     ? data.likes.filter(v => typeof v === 'string')     : [],
    favorites: Array.isArray(data.favorites) ? data.favorites.filter(v => typeof v === 'string')  : [],
    loves:     Array.isArray(data.loves)     ? data.loves.filter(v => typeof v === 'string')     : []
  };
}

function formatCount(data){
  return {
    likes:     data.likes.length,
    favorites: data.favorites.length,
    loves:     data.loves.length
  };
}

async function readReactions(articleId){
  if(!articleId) return emptyReactions();
  const raw = await redis.hget(DB_REACTIONS_HASH, articleId);
  return cleanReactions(parseStoredJson(raw, emptyReactions()));
}

async function writeReactions(articleId, reactions){
  const deduped = {
    likes:     Array.from(new Set(reactions.likes)),
    favorites: Array.from(new Set(reactions.favorites)),
    loves:     Array.from(new Set(reactions.loves))
  };
  await redis.hset(DB_REACTIONS_HASH, { [articleId]: JSON.stringify(deduped) });
  return deduped;
}

/* ---------- GET /api/reactions?articleId=xxx ---------- */

export async function onRequestGet(context){
  const url = new URL(context.request.url);
  const articleId = url.searchParams.get('articleId');
  const username  = url.searchParams.get('username');
  const articleIdsStr = url.searchParams.get('articleIds');

  /* 批量用户反应状态 */
  if(username && articleIdsStr){
    const articleIds = articleIdsStr.split(',').map(s => s.trim()).filter(Boolean);
    if(!articleIds.length){
      return json({ ok:true, userStatus:{} });
    }
    const userStatus = {};
    try{
      const rawList = await redis.hmget(DB_REACTIONS_HASH, ...articleIds);
      articleIds.forEach((id, i) => {
        const data = cleanReactions(parseStoredJson(rawList[i], emptyReactions()));
        userStatus[id] = {
          like:     data.likes.includes(username),
          favorite: data.favorites.includes(username),
          love:     data.loves.includes(username)
        };
      });
    }catch(error){
      console.error('reactions user batch error:', error);
      return json({ error:'获取反应状态失败。' }, 500);
    }
    return json({ ok:true, userStatus });
  }

  /* 单篇文章反应 */
  if(articleId){
    try{
      const data = await readReactions(articleId);
      return json({ ok:true, reactions: formatCount(data), users: data });
    }catch(error){
      console.error('reactions get error:', error);
      return json({ error:'获取反应数据失败。' }, 500);
    }
  }

  return json({ error:'缺少 articleId 参数。' }, 400);
}

/* ---------- POST /api/reactions (toggle) ---------- */

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }

  const body = await readJsonBody(context.request);
  const articleId = String(body.articleId || '').trim();
  const type      = String(body.type || '').trim().toLowerCase();

  if(!articleId){
    return json({ error:'缺少 articleId。' }, 400);
  }
  if(!VALID_TYPES.has(type)){
    return json({ error:'type 只支持 like、favorite、love。' }, 400);
  }

  const username = auth.user.username;

  try{
    const data = await readReactions(articleId);
    const list = data[type + 's']; // likes / favorites / loves
    const idx = list.indexOf(username);

    if(idx >= 0){
      list.splice(idx, 1); // 已反应 → 取消
    }else{
      list.push(username); // 未反应 → 添加
    }

    const saved = await writeReactions(articleId, data);
    return json({ ok:true, reactions: formatCount(saved) });
  }catch(error){
    console.error('reactions post error:', error);
    return json({ error:'操作失败，请重试。' }, 500);
  }
}

/* ---------- 其他方法不支持 ---------- */

export async function onRequest(){
  return json({ error:'只支持 GET 或 POST 请求。' }, 405);
}
