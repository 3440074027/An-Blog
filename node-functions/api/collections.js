import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';
import {
  DB_COLLECTIONS_HASH
} from './_lib/db-keys.js';

/**
 * 收藏夹 API
 * --------------------------------------------------
 * 数据结构：db:collections HASH
 *   field = collectionId
 *   value = {
 *     id, owner, name, cover, tags:[], summary,
 *     articles: [{ articleId, collectedAt }],
 *     createdAt, updatedAt
 *   }
 *
 * GET    /api/collections                          获取当前用户所有收藏夹
 * GET    /api/collections?id=<cid>                  获取单个收藏夹详情
 * POST   /api/collections                          创建收藏夹 { name, cover?, tags?, summary? }
 * PUT    /api/collections                          更新收藏夹 { id, name?, cover?, tags?, summary? }
 * DELETE /api/collections                          删除收藏夹 { id }
 * POST   /api/collections/collect                   收藏文章 { collectionId, articleId }
 * DELETE /api/collections/collect                   取消收藏 { collectionId, articleId }
 */

const MAX_NAME_LEN = 40;
const MAX_SUMMARY_LEN = 200;
const MAX_TAG_LEN = 20;
const MAX_TAGS_COUNT = 8;

async function readCollection(id){
  const raw = await redis.hget(DB_COLLECTIONS_HASH, id);
  if(!raw) return null;
  try{ return typeof raw === 'string' ? JSON.parse(raw) : raw; }catch(_){ return null; }
}

async function writeCollection(col){
  await redis.hset(DB_COLLECTIONS_HASH, { [col.id]: col });
}

function newId(){ return crypto.randomUUID(); }

/* ---- HTTP ---- */

export async function onRequestGet(context){
  try{
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');

    if(id){
      const col = await readCollection(id.trim().slice(0, 80));
      if(!col) return json({ error:'收藏夹不存在。' }, 404);
      return json({ ok:true, collection: col });
    }

    const auth = await requireUser(context.request);
    if(auth.error) return json({ error:auth.error }, auth.status);
    const owner = auth.user.username;
    const all = await redis.hvals(DB_COLLECTIONS_HASH);
    const collections = [];
    for(const raw of (all || [])){
      try{
        const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if(c.owner === owner){
          collections.push({
            id: c.id,
            name: c.name || '',
            cover: c.cover || '',
            tags: c.tags || [],
            summary: c.summary || '',
            articleCount: Array.isArray(c.articles) ? c.articles.length : 0,
            createdAt: c.createdAt || '',
            updatedAt: c.updatedAt || ''
          });
        }
      }catch(_){}
    }
    collections.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
    return json({ ok:true, collections });
  }catch(error){
    console.error('collections get error:', error);
    return json({ error:'获取收藏夹失败。' }, 500);
  }
}

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const action = String(body.action || '').trim();

    // 收藏文章到收藏夹
    if(action === 'collect'){
      const collectionId = String(body.collectionId || '').trim().slice(0, 80);
      const articleId = String(body.articleId || '').trim().slice(0, 80);
      if(!collectionId) return json({ error:'缺少收藏夹 ID。' }, 400);
      if(!articleId) return json({ error:'缺少文章 ID。' }, 400);
      const col = await readCollection(collectionId);
      if(!col) return json({ error:'收藏夹不存在。' }, 404);
      if(col.owner !== auth.user.username) return json({ error:'无权操作此收藏夹。' }, 403);
      if(!Array.isArray(col.articles)) col.articles = [];
      if(col.articles.some(e => e.articleId === articleId)){
        return json({ ok:true, message:'已在收藏夹中。', articleCount: col.articles.length });
      }
      col.articles.push({ articleId, collectedAt: nowIso() });
      col.updatedAt = nowIso();
      await writeCollection(col);
      return json({ ok:true, message:'收藏成功。', articleCount: col.articles.length });
    }

    // 创建收藏夹
    const name = String(body.name || '').trim().slice(0, MAX_NAME_LEN);
    if(!name) return json({ error:'收藏夹名称不能为空。' }, 400);
    const now = nowIso();
    const col = {
      id: newId(),
      owner: auth.user.username,
      name,
      cover: typeof body.cover === 'string' ? body.cover.slice(0, 420_000) : '',
      tags: Array.isArray(body.tags)
        ? body.tags.map(t => String(t).trim().slice(0, MAX_TAG_LEN)).filter(Boolean).slice(0, MAX_TAGS_COUNT)
        : [],
      summary: String(body.summary || '').trim().slice(0, MAX_SUMMARY_LEN),
      articles: [],
      createdAt: now,
      updatedAt: now
    };
    await writeCollection(col);
    return json({ ok:true, collection: col });
  }catch(error){
    console.error('collections post error:', error);
    return json({ error:'操作失败。' }, 500);
  }
}

export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const id = String(body.id || '').trim().slice(0, 80);
    if(!id) return json({ error:'缺少收藏夹 ID。' }, 400);
    const col = await readCollection(id);
    if(!col) return json({ error:'收藏夹不存在。' }, 404);
    if(col.owner !== auth.user.username) return json({ error:'无权操作此收藏夹。' }, 403);
    if(body.name !== undefined) col.name = String(body.name).trim().slice(0, MAX_NAME_LEN);
    if(body.cover !== undefined) col.cover = typeof body.cover === 'string' ? body.cover.slice(0, 420_000) : '';
    if(body.tags !== undefined){
      col.tags = Array.isArray(body.tags)
        ? body.tags.map(t => String(t).trim().slice(0, MAX_TAG_LEN)).filter(Boolean).slice(0, MAX_TAGS_COUNT)
        : [];
    }
    if(body.summary !== undefined) col.summary = String(body.summary).trim().slice(0, MAX_SUMMARY_LEN);
    col.updatedAt = nowIso();
    await writeCollection(col);
    return json({ ok:true, collection: col });
  }catch(error){
    console.error('collections put error:', error);
    return json({ error:'更新失败。' }, 500);
  }
}

export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const action = String(body.action || '').trim();

    // 取消收藏
    if(action === 'uncollect'){
      const collectionId = String(body.collectionId || '').trim().slice(0, 80);
      const articleId = String(body.articleId || '').trim().slice(0, 80);
      if(!collectionId || !articleId) return json({ error:'参数不完整。' }, 400);
      const col = await readCollection(collectionId);
      if(!col) return json({ error:'收藏夹不存在。' }, 404);
      if(col.owner !== auth.user.username) return json({ error:'无权操作此收藏夹。' }, 403);
      col.articles = (Array.isArray(col.articles) ? col.articles : []).filter(e => e.articleId !== articleId);
      col.updatedAt = nowIso();
      await writeCollection(col);
      return json({ ok:true, message:'已取消收藏。', articleCount: col.articles.length });
    }

    // 删除收藏夹
    const id = String(body.id || '').trim().slice(0, 80);
    if(!id) return json({ error:'缺少收藏夹 ID。' }, 400);
    const col = await readCollection(id);
    if(!col) return json({ error:'收藏夹不存在。' }, 404);
    if(col.owner !== auth.user.username) return json({ error:'无权操作此收藏夹。' }, 403);
    await redis.hdel(DB_COLLECTIONS_HASH, id);
    return json({ ok:true, message:'收藏夹已删除。' });
  }catch(error){
    console.error('collections delete error:', error);
    return json({ error:'操作失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
