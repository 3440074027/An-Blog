/**
 * 文章互动 API：点赞(like) / 收藏(favorite) / 喜欢(love)
 * 
 * GET  ?articleId=xxx          → 读取文章互动数据（总数 + 当前用户状态）
 * POST /api/reactions           → 切换互动状态 { articleId, type: 'like'|'favorite'|'love' }
 * DELETE /api/reactions         → 取消互动（不需要，POST 切换即可）
 */
import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';

const DB_REACTIONS_HASH = 'db:reactions';

// Redis key: db:reactions  HASH
//   field = articleId
//   value = JSON.stringify({ likes: Set<username>, favorites: Set<username>, loves: Set<username> })

async function getArticleReactions(articleId) {
  try {
    const raw = await redis.hget(DB_REACTIONS_HASH, articleId);
    if (!raw) return { likes: [], favorites: [], loves: [] };
    const data = JSON.parse(raw);
    return {
      likes: Array.isArray(data.likes) ? data.likes : [],
      favorites: Array.isArray(data.favorites) ? data.favorites : [],
      loves: Array.isArray(data.loves) ? data.loves : []
    };
  } catch (_) {
    return { likes: [], favorites: [], loves: [] };
  }
}

async function setArticleReactions(articleId, reactions) {
  await redis.hset(DB_REACTIONS_HASH, { [articleId]: JSON.stringify(reactions) });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const articleId = url.searchParams.get('articleId');
  if (!articleId) return json({ error: '缺少 articleId' }, 400);

  const reactions = await getArticleReactions(articleId);

  // 如果有认证用户，返回用户是否已互动
  let userStatus = { liked: false, favorited: false, loved: false };
  const user = await requireUser(context, { optional: true });
  if (user) {
    userStatus = {
      liked: reactions.likes.includes(user.username),
      favorited: reactions.favorites.includes(user.username),
      loved: reactions.loves.includes(user.username)
    };
  }

  return json({
    ok: true,
    articleId,
    counts: {
      likes: reactions.likes.length,
      favorites: reactions.favorites.length,
      loves: reactions.loves.length
    },
    userStatus
  });
}

export async function onRequestPost(context) {
  const user = await requireUser(context);
  if (!user) return;

  const body = await readJsonBody(context);
  const articleId = String(body.articleId || '').trim();
  const type = String(body.type || '').trim();

  if (!articleId || !['like', 'favorite', 'love'].includes(type)) {
    return json({ error: '参数错误，需要 articleId 和 type(like/favorite/love)' }, 400);
  }

  const reactions = await getArticleReactions(articleId);
  const username = user.username;
  const arrKey = type === 'like' ? 'likes' : type === 'favorite' ? 'favorites' : 'loves';
  const arr = reactions[arrKey];

  const index = arr.indexOf(username);
  let action; // 'added' or 'removed'
  if (index >= 0) {
    arr.splice(index, 1);
    action = 'removed';
  } else {
    arr.push(username);
    action = 'added';
  }

  await setArticleReactions(articleId, reactions);

  return json({
    ok: true,
    articleId,
    type,
    action,
    counts: {
      likes: reactions.likes.length,
      favorites: reactions.favorites.length,
      loves: reactions.loves.length
    }
  });
}

export function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method === 'GET') return onRequestGet(context);
  if (method === 'POST') return onRequestPost(context);
  return json({ error: 'Method not allowed' }, 405);
}
