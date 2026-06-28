import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';
import {
  DB_ARTICLE_LIKES_HASH,
  DB_ARTICLE_FAVORITES_HASH,
  DB_ARTICLES_HASH
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
    const username = String(url.searchParams.get('user') || '').trim().slice(0, 20);
    const type = String(url.searchParams.get('type') || '').trim(); // "like" or "favorite"

    // 模式1: 获取某用户点赞/收藏的文章列表
    if(username && type){
      const hashKey = type === 'like' ? DB_ARTICLE_LIKES_HASH : DB_ARTICLE_FAVORITES_HASH;
      if(type !== 'like' && type !== 'favorite') return json({ error:'type 只能是 like 或 favorite。' }, 400);
      // 从所有 reactions 中找出该用户点赞/收藏的文章 ID
      const allEntries = await redis.hgetall(hashKey);
      const articleIds = [];
      for(const [aid, val] of Object.entries(allEntries || {})){
        try{
          const data = typeof val === 'string' ? JSON.parse(val) : val;
          if(data && typeof data === 'object' && username in data){
            articleIds.push(aid);
          }
        }catch(_){}
      }
      // 获取文章详情（标题、封面等）
      if(!articleIds.length) return json({ ok: true, articles: [] });
      const articleDetails = [];
      for(const aid of articleIds.slice(0, 100)){
        const raw = await redis.hget(DB_ARTICLES_HASH, aid);
        if(!raw) continue;
        try{
          const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
          articleDetails.push({
            id: a.id,
            title: a.title || '未命名文章',
            summary: a.summary || '',
            thumb: a.thumb || '',
            author: a.author || '',
            category: a.category || '随笔',
            createdAt: a.createdAt || ''
          });
        }catch(_){}
      }
      return json({ ok: true, articles: articleDetails });
    }

    // 模式2: 获取某用户所有点赞/收藏的文章ID（用于计数）
    if(username){
      const [likesRaw, favsRaw] = await Promise.all([
        redis.hgetall(DB_ARTICLE_LIKES_HASH),
        redis.hgetall(DB_ARTICLE_FAVORITES_HASH)
      ]);
      let likeCount = 0, favCount = 0;
      for(const val of Object.values(likesRaw || {})){
        try{
          const data = typeof val === 'string' ? JSON.parse(val) : val;
          if(data && typeof data === 'object' && username in data) likeCount++;
        }catch(_){}
      }
      for(const val of Object.values(favsRaw || {})){
        try{
          const data = typeof val === 'string' ? JSON.parse(val) : val;
          if(data && typeof data === 'object' && username in data) favCount++;
        }catch(_){}
      }
      return json({ ok: true, likeCount, favoriteCount });
    }

    // 模式3: 获取单篇文章的互动数据（原有逻辑）
    if(!articleId) return json({ error:'缺少文章 ID 或用户名。' }, 400);

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
