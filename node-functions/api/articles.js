import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';

const ARTICLE_INDEX_KEY = 'site:article-index:v2';
const ARTICLE_KEY_PREFIX = 'site:article:';

function cleanHtml(html){
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .slice(0, 1_800_000);
}

function sanitizeArticle(input = {}, fallbackAuthor = ''){
  const author = String(input.author || fallbackAuthor || '').trim().slice(0, 20);
  const title = String(input.title || '').trim().slice(0, 120) || '未命名文章';
  const category = String(input.category || '随笔').trim().slice(0, 40) || '随笔';
  const tags = Array.isArray(input.tags)
    ? input.tags.map(tag=>String(tag).trim()).filter(Boolean).slice(0, 8).map(tag=>tag.slice(0, 24))
    : String(input.tags || category).split(/[,，/、\s]+/).map(tag=>tag.trim()).filter(Boolean).slice(0, 8).map(tag=>tag.slice(0, 24));
  const content = cleanHtml(input.content);
  const now = nowIso();
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 80) : crypto.randomUUID(),
    title,
    category,
    tags,
    summary: String(input.summary || '').trim().slice(0, 260),
    content,
    thumb: typeof input.thumb === 'string' && input.thumb.length <= 900_000 && (input.thumb.startsWith('data:image/') || input.thumb.startsWith('linear-gradient(')) ? input.thumb : 'linear-gradient(135deg,#7c5cff,#ff8fc7)',
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
    fontFamily: article.fontFamily,
    author: article.author,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt
  };
}

async function readArticleIndex(){
  const index = await redis.get(ARTICLE_INDEX_KEY);
  return Array.isArray(index) ? index.map(item=>toArticleMeta(sanitizeArticle(item, item.author))).filter(item=>item.author && item.id) : [];
}

async function writeArticleIndex(index){
  await redis.set(ARTICLE_INDEX_KEY, index.slice(0, 1000).map(toArticleMeta));
}

async function getArticle(id){
  const article = await redis.get(`${ARTICLE_KEY_PREFIX}${id}`);
  return article ? sanitizeArticle(article, article.author) : null;
}

async function saveArticle(article){
  await redis.set(`${ARTICLE_KEY_PREFIX}${article.id}`, article);
  const index = await readArticleIndex();
  const existing = index.findIndex(item=>item.id === article.id);
  const meta = toArticleMeta(article);
  if(existing >= 0) index[existing] = meta;
  else index.unshift(meta);
  index.sort((a, b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  await writeArticleIndex(index);
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
    const index = await readArticleIndex();
    const targetArticles = [];
    for(const id of ids){
      const article = await getArticle(id);
      if(article) targetArticles.push(article);
    }
    const forbidden = targetArticles.some(article=>article.author !== auth.user.username);
    if(forbidden) return json({ error:'只能删除自己发布的文章。' }, 403);
    for(const article of targetArticles){
      await redis.del(`${ARTICLE_KEY_PREFIX}${article.id}`);
    }
    await writeArticleIndex(index.filter(article=>!ids.includes(article.id)));
    return json({ ok:true, deleted:targetArticles.length });
  }catch(error){
    console.error('articles delete error:', error);
    return json({ error:error.message || '删除文章失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
