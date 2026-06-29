import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';
import {
  DB_ARTICLES_HASH,
  DB_ARTICLE_LIKES_HASH,
  DB_ARTICLE_FAVORITES_HASH
} from './_lib/db-keys.js';

/**
 * 文章互动 API（点赞 / 收藏）
 * --------------------------------------------------
 * 数据存储在文章记录内（db:articles hash 的文章 JSON 中）：
 *   article.likes     = { username: isoTimestamp, ... }
 *   article.favorites = { username: isoTimestamp, ... }
 *
 * GET    /api/article-reactions?id=<aid>            获取某文章的点赞和收藏计数
 * GET    /api/article-reactions?id=<aid>&me=true     获取当前用户对该文章的点赞/收藏状态
 * GET    /api/article-reactions?user=<u>            获取某用户的点赞/收藏总数
 * GET    /api/article-reactions?user=<u>&type=like   获取某用户点赞/收藏的文章列表
 * POST   /api/article-reactions                     点赞或收藏 { id, action:"like"|"favorite" }
 * DELETE /api/article-reactions                     取消点赞或收藏 { id, action:"like"|"favorite" }
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

/* ---- 从文章记录中读取 likes/favorites ---- */

async function getArticleRaw(articleId){
  const raw = await redis.hget(DB_ARTICLES_HASH, articleId);
  if(!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function readReactions(articleId){
  const article = await getArticleRaw(articleId);
  if(!article) return { likeCount:0, favoriteCount:0, likes:{}, favorites:{} };
  const likes = (article.likes && typeof article.likes === 'object') ? article.likes : {};
  const favorites = (article.favorites && typeof article.favorites === 'object') ? article.favorites : {};
  return {
    likeCount: Object.keys(likes).length,
    favoriteCount: Object.keys(favorites).length,
    likes,
    favorites
  };
}

/* ---- 切换点赞/收藏（写入文章记录） ---- */

async function toggleReaction(articleId, username, action, add){
  if(!articleId || !username) return null;
  const raw = await redis.hget(DB_ARTICLES_HASH, articleId);
  if(!raw) return null;
  const article = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const field = action; // "like" 或 "favorite"
  if(!article[field] || typeof article[field] !== 'object') article[field] = {};

  if(add){
    article[field][username] = nowIso();
  }else{
    delete article[field][username];
  }

  await redis.hset(DB_ARTICLES_HASH, { [articleId]: article });
  const count = Object.keys(article[field]).length;
  return { count };
}

/* ---- 旧数据迁移：从独立 hash 合并到文章记录 ---- */
let _migrated = false;
async function migrateLegacyReactions(articleId){
  if(_migrated) return; // 每次请求周期只迁移一次
  _migrated = true;
  try{
    const [likesRaw, favsRaw] = await Promise.all([
      redis.hget(DB_ARTICLE_LIKES_HASH, articleId),
      redis.hget(DB_ARTICLE_FAVORITES_HASH, articleId)
    ]);
    if(!likesRaw && !favsRaw) return; // 无旧数据
    const raw = await redis.hget(DB_ARTICLES_HASH, articleId);
    if(!raw) return;
    const article = typeof raw === 'string' ? JSON.parse(raw) : raw;
    let dirty = false;
    if(likesRaw){
      const likes = parseStoredJson(likesRaw, {});
      if(Object.keys(likes).length){
        if(!article.likes || typeof article.likes !== 'object') article.likes = {};
        Object.assign(article.likes, likes);
        dirty = true;
      }
    }
    if(favsRaw){
      const favs = parseStoredJson(favsRaw, {});
      if(Object.keys(favs).length){
        if(!article.favorites || typeof article.favorites !== 'object') article.favorites = {};
        Object.assign(article.favorites, favs);
        dirty = true;
      }
    }
    if(dirty){
      await redis.hset(DB_ARTICLES_HASH, { [articleId]: article });
    }
    // 清理旧 hash 中的该文章记录
    if(likesRaw) await redis.hdel(DB_ARTICLE_LIKES_HASH, articleId);
    if(favsRaw) await redis.hdel(DB_ARTICLE_FAVORITES_HASH, articleId);
  }catch(error){
    console.error('migrate legacy reactions error:', error);
  }
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
      if(type !== 'like' && type !== 'favorite') return json({ error:'type 只能是 like 或 favorite。' }, 400);
      const field = type;
      const allArticles = await redis.hvals(DB_ARTICLES_HASH);
      const articleDetails = [];
      for(const raw of (allArticles || [])){
        try{
          const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const data = (a[field] && typeof a[field] === 'object') ? a[field] : {};
          if(username in data){
            articleDetails.push({
              id: a.id,
              title: a.title || '未命名文章',
              summary: a.summary || '',
              thumb: a.thumb || '',
              author: a.author || '',
              category: a.category || '随笔',
              createdAt: a.createdAt || ''
            });
          }
        }catch(_){}
      }
      return json({ ok: true, articles: articleDetails });
    }

    // 模式2: 获取某用户的点赞/收藏总数（扫描文章列表）
    if(username){
      const allArticles = await redis.hvals(DB_ARTICLES_HASH);
      let likeCount = 0, favCount = 0;
      for(const raw of (allArticles || [])){
        try{
          const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const likes = (a.likes && typeof a.likes === 'object') ? a.likes : {};
          const favs = (a.favorites && typeof a.favorites === 'object') ? a.favorites : {};
          if(username in likes) likeCount++;
          if(username in favs) favCount++;
        }catch(_){}
      }
      // 同时检查旧 hash 数据并迁移
      const [likesRaw, favsRaw] = await Promise.all([
        redis.hgetall(DB_ARTICLE_LIKES_HASH),
        redis.hgetall(DB_ARTICLE_FAVORITES_HASH)
      ]);
      if(Object.keys(likesRaw || {}).length || Object.keys(favsRaw || {}).length){
        // 旧数据存在，迁移
        for(const [aid, val] of Object.entries(likesRaw || {})){
          try{
            const data = parseStoredJson(val, {});
            if(username in data) likeCount++;
          }catch(_){}
        }
        for(const [aid, val] of Object.entries(favsRaw || {})){
          try{
            const data = parseStoredJson(val, {});
            if(username in data) favCount++;
          }catch(_){}
        }
        // 异步触发全量迁移（不阻塞响应）
        migrateLegacyAll().catch(()=>{});
      }
      return json({ ok: true, likeCount, favoriteCount });
    }

    // 模式3: 获取单篇文章的互动数据
    if(!articleId) return json({ error:'缺少文章 ID 或用户名。' }, 400);

    // 先尝试从文章记录读取
    const article = await getArticleRaw(articleId);
    if(!article) return json({ error:'文章不存在。' }, 404);

    // 如果文章记录中没有内嵌数据，尝试从旧 hash 迁移
    if(!article.likes || !article.favorites){
      await migrateLegacyReactions(articleId);
      // 重新读取
      const fresh = await getArticleRaw(articleId);
      if(fresh){
        article.likes = fresh.likes || {};
        article.favorites = fresh.favorites || {};
      }
    }

    const likes = (article.likes && typeof article.likes === 'object') ? article.likes : {};
    const favorites = (article.favorites && typeof article.favorites === 'object') ? article.favorites : {};

    // 如果请求了当前用户的状态
    const me = url.searchParams.get('me') === 'true';
    if(me){
      const auth = await requireUser(context.request);
      if(auth.error){
        return json({
          ok: true,
          likeCount: Object.keys(likes).length,
          favoriteCount: Object.keys(favorites).length,
          liked: false,
          favorited: false
        });
      }
      const u = auth.user.username;
      return json({
        ok: true,
        likeCount: Object.keys(likes).length,
        favoriteCount: Object.keys(favorites).length,
        liked: u in likes,
        favorited: u in favorites
      });
    }

    return json({
      ok: true,
      likeCount: Object.keys(likes).length,
      favoriteCount: Object.keys(favorites).length
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

    // 先迁移旧数据
    await migrateLegacyReactions(articleId);

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

    // 先迁移旧数据
    await migrateLegacyReactions(articleId);

    const result = await toggleReaction(articleId, username, action, false);
    const key = action === 'like' ? 'likeCount' : 'favoriteCount';
    return json({ ok: true, [key]: result?.count || 0 });
  }catch(error){
    console.error('article-reactions delete error:', error);
    return json({ error:'取消操作失败。' }, 500);
  }
}

/* ---- 全量迁移旧 hash 数据到文章记录 ---- */
async function migrateLegacyAll(){
  try{
    const [allLikes, allFavs] = await Promise.all([
      redis.hgetall(DB_ARTICLE_LIKES_HASH),
      redis.hgetall(DB_ARTICLE_FAVORITES_HASH)
    ]);
    const likeEntries = Object.entries(allLikes || {});
    const favEntries = Object.entries(allFavs || {});
    if(!likeEntries.length && !favEntries.length) return;

    // 收集所有涉及的 articleId
    const articleIds = new Set([
      ...likeEntries.map(e => e[0]),
      ...favEntries.map(e => e[0])
    ]);

    for(const aid of articleIds){
      const raw = await redis.hget(DB_ARTICLES_HASH, aid);
      if(!raw) continue;
      const article = typeof raw === 'string' ? JSON.parse(raw) : raw;

      const likeVal = allLikes[aid];
      const favVal = allFavs[aid];
      let dirty = false;

      if(likeVal){
        const likes = parseStoredJson(likeVal, {});
        if(Object.keys(likes).length){
          if(!article.likes || typeof article.likes !== 'object') article.likes = {};
          Object.assign(article.likes, likes);
          dirty = true;
        }
      }
      if(favVal){
        const favs = parseStoredJson(favVal, {});
        if(Object.keys(favs).length){
          if(!article.favorites || typeof article.favorites !== 'object') article.favorites = {};
          Object.assign(article.favorites, favs);
          dirty = true;
        }
      }

      if(dirty){
        await redis.hset(DB_ARTICLES_HASH, { [aid]: article });
      }
    }

    // 迁移完成后删除旧 hash
    if(likeEntries.length) await redis.del(DB_ARTICLE_LIKES_HASH);
    if(favEntries.length) await redis.del(DB_ARTICLE_FAVORITES_HASH);
    console.log(`migrated ${likeEntries.length} like entries, ${favEntries.length} fav entries to articles`);
  }catch(error){
    console.error('migrateLegacyAll error:', error);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST 或 DELETE 请求。' }, 405);
}
