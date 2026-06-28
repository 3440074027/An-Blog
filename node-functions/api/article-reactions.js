import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';
import {
  DB_ARTICLE_LIKES_HASH,
  DB_ARTICLE_FAVORITES_HASH
} from './_lib/db-keys.js';

/**
 * 文章互动 API（点赞 / 收藏）
 * --------------------------------------------------
 * GET    /api/article-reactions?id=<aid>          获取某文章的点赞和收藏计数
 * GET    /api/article-reactions?id=<aid>&me=true   获取当前用户对该文章的点赞/收藏状态
 * POST   /api/article-reactions                    点赞或收藏 { id, action:"like"|"favorite" }
 * DELETE /api/article-reactions                    取消点赞或收藏 { id, action:"like"|"favorite" }
 */

const MAX_USERNAME_LEN = 20;

function parseStoredJson(value, fallback){
  if(!value) return fallback;
  if(typeof value === 'object') return value;
  if(typeof value === 'string'){
    try{
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    }catch(_){ return fallback; }
  }
  return fallback;
}

async function readReactions(articleId){
  const [likesRaw, favsRaw] = await Promise.all([
    redis.hget(DB_ARTICLE_LIKES_HASH, articleId),
    redis.hget(DB_ARTICLE_FAVORITES_HASH, articleId)
  ]);
  const likes = parseStoredJson(likesRaw, {});
  const favorites = parseStoredJson(favsRaw, {});
  return {
    likeCount: Object.keys(likes).length,
    favoriteCount: Object.keys(favorites).length,
    likes,
    favorites
  };
}

async function toggleReaction(articleId, username, action, add){
  if(!articleId || !username) return null;
  const hashKey = action === 'like' ? DB_ARTICLE_LIKES_HASH : DB_ARTICLE_FAVORITES_HASH;
  const raw = await redis.hget(hashKey, articleId);
  const data = parseStoredJson(raw, {});
  if(add){
    data[username] = nowIso();
  }else{
    delete data[username];
  }
  // 如果数据为空则删除该 field，节省空间
  if(Object.keys(data).length === 0){
    await redis.hdel(hashKey, articleId);
    return { count: 0 };
  }
  await redis.hset(hashKey, { [articleId]: JSON.stringify(data) });
  return { count: Object.keys(data).length };
}

/* ------------------ HTTP 处理 ------------------ */

export async function onRequestGet(context){
  try{
    const url = new URL(context.request.url);
    const articleId = String(url.searchParams.get('id') || '').trim().slice(0, 80);
    if(!articleId) return json({ error:'缺少文章 ID。' }, 400);

    const reactions = await readReactions(articleId);

    // 如果请求了当前用户的状态
    const me = url.searchParams.get('me') === 'true';
    if(me){
      const auth = await requireUser(context.request);
      if(auth.error){
        // 未登录用户只返回计数
        return json({
          ok: true,
          likeCount: reactions.likeCount,
          favoriteCount: reactions.favoriteCount,
          liked: false,
          favorited: false
        });
      }
      const username = auth.user.username;
      return json({
        ok: true,
        likeCount: reactions.likeCount,
        favoriteCount: reactions.favoriteCount,
        liked: username in reactions.likes,
        favorited: username in reactions.favorites
      });
    }

    return json({
      ok: true,
      likeCount: reactions.likeCount,
      favoriteCount: reactions.favoriteCount
    });
  }catch(error){
    console.error('article-reactions get error:', error);
    return json({ error:'读取互动数据失败。' }, 500);
  }
}

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const articleId = String(body.id || '').trim().slice(0, 80);
    const action = String(body.action || '').trim();
    if(!articleId) return json({ error:'缺少文章 ID。' }, 400);
    if(action !== 'like' && action !== 'favorite') return json({ error:'action 只能是 like 或 favorite。' }, 400);

    const username = auth.user.username.slice(0, MAX_USERNAME_LEN);
    const result = await toggleReaction(articleId, username, action, true);
    const key = action === 'like' ? 'likeCount' : 'favoriteCount';
    return json({ ok: true, [key]: result?.count || 0 });
  }catch(error){
    console.error('article-reactions post error:', error);
    return json({ error:'操作失败。' }, 500);
  }
}

export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const articleId = String(body.id || '').trim().slice(0, 80);
    const action = String(body.action || '').trim();
    if(!articleId) return json({ error:'缺少文章 ID。' }, 400);
    if(action !== 'like' && action !== 'favorite') return json({ error:'action 只能是 like 或 favorite。' }, 400);

    const username = auth.user.username.slice(0, MAX_USERNAME_LEN);
    const result = await toggleReaction(articleId, username, action, false);
    const key = action === 'like' ? 'likeCount' : 'favoriteCount';
    return json({ ok: true, [key]: result?.count || 0 });
  }catch(error){
    console.error('article-reactions delete error:', error);
    return json({ error:'取消操作失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST 或 DELETE 请求。' }, 405);
}
