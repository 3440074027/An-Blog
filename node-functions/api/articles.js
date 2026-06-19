import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso,
  bumpArticlesVersion
} from './_lib/auth.js';
import {
  DB_ARTICLES_HASH,
  LEGACY_ARTICLE_INDEX_KEY,
  LEGACY_ARTICLES_KEY,
  legacyArticleKey
} from './_lib/db-keys.js';

function cleanHtml(html){
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .slice(0, 1_800_000);
}

function extractImagesFromHtml(html){
  const matches = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/gi) || [];
  return matches
    .map(tag=>{
      const match = tag.match(/src=["']([^"']+)["']/i);
      return match ? match[1] : '';
    })
    .filter(src=>src.startsWith('data:image/') && src.length <= 420_000)
    .slice(0, 5);
}

function sanitizeArticle(input = {}, fallbackAuthor = ''){
  const author = String(input.author || fallbackAuthor || '').trim().slice(0, 20);
  const title = String(input.title || '').trim().slice(0, 120) || '未命名文章';
  const category = String(input.category || '随笔').trim().slice(0, 40) || '随笔';
  const tags = Array.isArray(input.tags)
    ? input.tags.map(tag=>String(tag).trim()).filter(Boolean).slice(0, 8).map(tag=>tag.slice(0, 24))
    : String(input.tags || category).split(/[,，/、\s]+/).map(tag=>tag.trim()).filter(Boolean).slice(0, 8).map(tag=>tag.slice(0, 24));
  const content = cleanHtml(input.content);
  const inputGallery = Array.isArray(input.gallery)
    ? input.gallery.filter(src=>typeof src === 'string' && src.startsWith('data:image/') && src.length <= 420_000).slice(0, 5)
    : [];
  const gallery = extractImagesFromHtml(content);
  const finalGallery = gallery.length ? gallery : inputGallery;
  const now = nowIso();
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 80) : crypto.randomUUID(),
    title,
    category,
    tags,
    summary: String(input.summary || '').trim().slice(0, 260),
    content,
    thumb: finalGallery[0] || (typeof input.thumb === 'string' && input.thumb.length <= 420_000 && (input.thumb.startsWith('data:image/') || input.thumb.startsWith('linear-gradient(')) ? input.thumb : 'linear-gradient(135deg,#7c5cff,#ff8fc7)'),
    gallery: finalGallery,
    fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily.slice(0, 120) : '',
    author,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : now,
    updatedAt: now
  };
}

function toArticleMeta(article){
  return {
    id: article.id,
    title: article.title,
    category: article.category,
    tags: article.tags,
    summary: article.summary,
    thumb: article.thumb,
    gallery: Array.isArray(article.gallery) ? article.gallery.slice(0, 5) : [],
    fontFamily: article.fontFamily,
    author: article.author,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt
  };
}

async function readArticleIndex(){
  try{
    const articles = await redis.hvals(DB_ARTICLES_HASH);
    if(Array.isArray(articles) && articles.length){
      return articles
        .map(article=>toArticleMeta(sanitizeArticle(article, article.author)))
        .filter(item=>item.author && item.id)
        .sort((a, b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    }
  }catch(error){
    console.error('read articles hash error:', error);
  }

  const legacyIndex = await redis.get(LEGACY_ARTICLE_INDEX_KEY);
  if(Array.isArray(legacyIndex) && legacyIndex.length){
    const migrated = [];
    for(const item of legacyIndex.slice(0, 1000)){
      const full = await redis.get(legacyArticleKey(item.id));
      migrated.push(sanitizeArticle(full || item, item.author));
    }
    const valid = migrated.filter(article=>article.author && article.id);
    if(valid.length){
      const payload = Object.fromEntries(valid.map(article=>[article.id, article]));
      await redis.hset(DB_ARTICLES_HASH, payload);
      return valid.map(toArticleMeta).sort((a, b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    }
  }

  try{
    const legacyArticles = await redis.get(LEGACY_ARTICLES_KEY);
    if(Array.isArray(legacyArticles) && legacyArticles.length){
      const migrated = legacyArticles.map(article=>sanitizeArticle(article, article.author)).filter(article=>article.author && article.id);
      if(migrated.length){
        const payload = Object.fromEntries(migrated.slice(0, 1000).map(article=>[article.id, article]));
        await redis.hset(DB_ARTICLES_HASH, payload);
      }
      return migrated.map(toArticleMeta).sort((a, b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    }
  }catch(error){
    console.error('legacy articles migration skipped:', error);
  }
  return [];
}

async function writeArticleIndex(index){
  // 集中表模式下不再维护单独索引；列表由 db:articles 的 HVALS 生成。
  return index;
}

async function getArticle(id){
  const article = await redis.hget(DB_ARTICLES_HASH, id);
  if(article) return sanitizeArticle(article, article.author);
  const legacy = await redis.get(legacyArticleKey(id));
  if(legacy){
    const migrated = sanitizeArticle(legacy, legacy.author);
    await redis.hset(DB_ARTICLES_HASH, { [migrated.id]: migrated });
    return migrated;
  }
  return null;
}

async function saveArticle(article){
  await redis.hset(DB_ARTICLES_HASH, { [article.id]: article });
  await bumpArticlesVersion();
}

export async function onRequestGet(context){
  try{
    const url = new URL(context.request.url);
    const id = url.searchParams.get('id');
    if(id){
      const article = await getArticle(id);
      if(!article) return json({ error:'文章不存在。' }, 404);
      return json({ ok:true, article });
    }
    const articles = await readArticleIndex();
    return json({ ok:true, articles:articles.sort((a, b)=>String(b.createdAt).localeCompare(String(a.createdAt))) });
  }catch(error){
    console.error('articles get error:', error);
    return json({ error:'读取文章失败。' }, 500);
  }
}

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const article = sanitizeArticle(body.article || body || {}, auth.user.username);
    if(!article.content) return json({ error:'文章正文不能为空。' }, 400);
    await saveArticle(article);
    return json({ ok:true, article });
  }catch(error){
    console.error('articles post error:', error);
    return json({ error:error.message || '发布文章失败。' }, 500);
  }
}

export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const next = sanitizeArticle(body.article || {}, auth.user.username);
    const previous = await getArticle(next.id);
    if(!previous) return json({ error:'文章不存在。' }, 404);
    if(previous.author !== auth.user.username) return json({ error:'只能修改自己发布的文章。' }, 403);
    const article = { ...next, author:auth.user.username, createdAt:previous.createdAt, updatedAt:nowIso() };
    await saveArticle(article);
    return json({ ok:true, article });
  }catch(error){
    console.error('articles put error:', error);
    return json({ error:error.message || '修改文章失败。' }, 500);
  }
}

export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const ids = Array.isArray(body.ids) ? body.ids.map(id=>String(id)) : [];
    if(!ids.length) return json({ error:'请选择要删除的文章。' }, 400);
    const targetArticles = [];
    for(const id of ids){
      const article = await getArticle(id);
      if(article) targetArticles.push(article);
    }
    const forbidden = targetArticles.some(article=>article.author !== auth.user.username);
    if(forbidden) return json({ error:'只能删除自己发布的文章。' }, 403);
    for(const article of targetArticles){
      await redis.hdel(DB_ARTICLES_HASH, article.id);
    }
    await bumpArticlesVersion();
    return json({ ok:true, deleted:targetArticles.length });
  }catch(error){
    console.error('articles delete error:', error);
    return json({ error:error.message || '删除文章失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
