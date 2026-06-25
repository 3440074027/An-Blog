import { redis } from './_lib/redis-client.js';
import { DB_INTERACTIONS_HASH } from './_lib/db-keys.js';
import { getCurrentUser, unauthorized, badRequest, jsonOk } from './_lib/auth.js';

const VALID_ACTIONS = ['like', 'favorite', 'love'];

function sanitizeId(id){
  return String(id || '').trim().slice(0, 128);
}

// 获取文章的互动数据
async function getInteractions(articleId){
  if(!articleId) return { likes: 0, favorites: 0, loves: 0, likedBy: [], favoritedBy: [], lovedBy: [] };
  try{
    const raw = await redis.hget(DB_INTERACTIONS_HASH, articleId);
    if(!raw) return { likes: 0, favorites: 0, loves: 0, likedBy: [], favoritedBy: [], lovedBy: [] };
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      likes: Number(data.likes) || 0,
      favorites: Number(data.favorites) || 0,
      loves: Number(data.loves) || 0,
      likedBy: Array.isArray(data.likedBy) ? data.likedBy : [],
      favoritedBy: Array.isArray(data.favoritedBy) ? data.favoritedBy : [],
      lovedBy: Array.isArray(data.lovedBy) ? data.lovedBy : []
    };
  }catch(error){
    console.error('getInteractions error:', error);
    return { likes: 0, favorites: 0, loves: 0, likedBy: [], favoritedBy: [], lovedBy: [] };
  }
}

// 保存文章互动数据
async function saveInteractions(articleId, data){
  if(!articleId) return;
  try{
    await redis.hset(DB_INTERACTIONS_HASH, { [articleId]: JSON.stringify(data) });
  }catch(error){
    console.error('saveInteractions error:', error);
  }
}

export default async function handler(req, res){
  res.setHeader('Content-Type', 'application/json');

  // GET /api/interactions?articleId=xxx 获取互动数据
  if(req.method === 'GET'){
    const articleId = sanitizeId(req.query?.articleId || req.url?.split('articleId=')[1]?.split('&')[0]);
    if(!articleId) return badRequest(res, '缺少 articleId 参数');
    const data = await getInteractions(articleId);
    const user = await getCurrentUser(req);
    const username = user?.username || '';
    return jsonOk(res, {
      ok: true,
      articleId,
      likes: data.likes,
      favorites: data.favorites,
      loves: data.loves,
      liked: username ? data.likedBy.includes(username) : false,
      favorited: username ? data.favoritedBy.includes(username) : false,
      loved: username ? data.lovedBy.includes(username) : false
    });
  }

  // POST /api/interactions 添加/取消互动
  if(req.method === 'POST'){
    const user = await getCurrentUser(req);
    if(!user) return unauthorized(res);
    const username = user.username;

    let body = {};
    try{
      body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    }catch(_){}

    const articleId = sanitizeId(body.articleId);
    const action = String(body.action || '').trim().toLowerCase();
    const cancel = body.cancel === true || body.cancel === 'true';

    if(!articleId) return badRequest(res, '缺少 articleId');
    if(!VALID_ACTIONS.includes(action)) return badRequest(res, '无效的操作类型');

    const data = await getInteractions(articleId);
    const listKey = action + 'By'; // likedBy / favoritedBy / lovedBy
    const countKey = action + 's'; // likes / favorites / loves
    const already = data[listKey].includes(username);

    if(cancel){
      // 取消互动
      if(already){
        data[listKey] = data[listKey].filter(u => u !== username);
        data[countKey] = Math.max(0, (data[countKey] || 0) - 1);
        await saveInteractions(articleId, data);
      }
      return jsonOk(res, {
        ok: true, articleId, action, canceled: true,
        [countKey]: data[countKey],
        [action + 'd']: false
      });
    }else{
      // 添加互动
      if(!already){
        data[listKey].push(username);
        data[countKey] = (data[countKey] || 0) + 1;
        await saveInteractions(articleId, data);
      }
      return jsonOk(res, {
        ok: true, articleId, action, canceled: false,
        [countKey]: data[countKey],
        [action + 'd']: true
      });
    }
  }

  return badRequest(res, '不支持的请求方法');
}
