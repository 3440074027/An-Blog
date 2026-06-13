import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  redis,
  nowIso
} from './_lib/auth.js';

const ARTICLES_KEY = 'site:articles';

function cleanHtml(html){
  return String(html || '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .slice(0, 8_000_000);
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
    thumb: typeof input.thumb === 'string' && (input.thumb.startsWith('data:image/') || input.thumb.startsWith('linear-gradient(')) ? input.thumb.slice(0, 4_800_000) : 'linear-gradient(135deg,#7c5cff,#ff8fc7)',
    fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily.slice(0, 120) : '',
    author,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt.slice(0, 40) : now,
    updatedAt: now
  };
}

async function readArticles(){
  const articles = await redis.get(ARTICLES_KEY);
  return Array.isArray(articles) ? articles.map(article=>sanitizeArticle(article, article.author)).filter(article=>article.author) : [];
}

async function writeArticles(articles){
  await redis.set(ARTICLES_KEY, articles.slice(0, 1000));
}

export async function onRequestGet(){
  try{
    const articles = await readArticles();
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
    const articles = await readArticles();
    articles.unshift(article);
    await writeArticles(articles);
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
    const articles = await readArticles();
    const index = articles.findIndex(article=>article.id === next.id);
    if(index < 0) return json({ error:'文章不存在。' }, 404);
    if(articles[index].author !== auth.user.username) return json({ error:'只能修改自己发布的文章。' }, 403);
    articles[index] = { ...next, author:auth.user.username, createdAt:articles[index].createdAt, updatedAt:nowIso() };
    await writeArticles(articles);
    return json({ ok:true, article:articles[index] });
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
    const articles = await readArticles();
    const forbidden = articles.some(article=>ids.includes(article.id) && article.author !== auth.user.username);
    if(forbidden) return json({ error:'只能删除自己发布的文章。' }, 403);
    const remain = articles.filter(article=>!ids.includes(article.id));
    await writeArticles(remain);
    return json({ ok:true, deleted:articles.length - remain.length });
  }catch(error){
    console.error('articles delete error:', error);
    return json({ error:error.message || '删除文章失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
