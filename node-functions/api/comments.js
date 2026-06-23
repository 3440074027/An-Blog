import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  isSiteOwner,
  redis
} from './_lib/auth.js';
import { DB_COMMENTS_HASH, DB_ARTICLES_HASH } from './_lib/db-keys.js';

/* 获取文章的所有评论（按时间正序） */
export async function onRequestGet(context){
  try{
    const url = new URL(context.request.url);
    const articleId = String(url.searchParams.get('articleId') || '').trim();
    if(!articleId){
      return json({ error:'缺少文章ID。' }, 400);
    }
    // 获取该文章所有评论
    const raw = await redis.hgetall(DB_COMMENTS_HASH);
    if(!raw) return json({ comments:[] });
    const comments = [];
    for(const [id, val] of Object.entries(raw)){
      try{
        const c = JSON.parse(val);
        if(c.articleId === articleId){
          // 脱敏：只返回需要的字段
          comments.push({
            id: c.id,
            articleId: c.articleId,
            author: c.author,
            content: c.content,
            image: c.image || null,
            parentId: c.parentId || null,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          });
        }
      }catch(_){}
    }
    comments.sort((a,b)=> a.createdAt.localeCompare(b.createdAt));
    return json({ comments });
  }catch(error){
    console.error('comments GET error:', error);
    return json({ error:'获取评论失败。' }, 500);
  }
}

/* 发表评论 */
export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const articleId = String(body.articleId || '').trim();
    const content = String(body.content || '').trim();
    const image = body.image || '';
    const parentId = body.parentId ? String(body.parentId).trim() : null;

    if(!articleId) return json({ error:'缺少文章ID。' }, 400);
    if(!content) return json({ error:'请输入评论内容。' }, 400);
    if(content.length > 2000) return json({ error:'评论内容不能超过2000字。' }, 400);

    // 检查评论权限
    const currentUser = auth.user;
    const tags = currentUser.profile?.tags || [];
    if(tags.includes('no_comment')){
      return json({ error:'您已被禁止发表评论。' }, 403);
    }
    if(image && tags.includes('no_comment_image')){
      return json({ error:'您已被禁止上传评论图片。' }, 403);
    }

    // 检查文章是否存在
    const articleExists = await redis.hexists(DB_ARTICLES_HASH, articleId);
    if(!articleExists) return json({ error:'文章不存在。' }, 404);

    // 压缩图片到1MB以内
    let processedImage = '';
    if(image && image.startsWith('data:image/')){
      const maxSize = 1 * 1024 * 1024; // 1MB
      const rawSize = Buffer.byteLength(image, 'utf-8');
      if(rawSize > maxSize){
        // 前端应已压缩，这里做二次校验，超1MB则拒绝
        return json({ error:'图片大小不能超过1MB。' }, 400);
      }
      processedImage = image;
    }

    const now = nowIso();
    const comment = {
      id: crypto.randomUUID(),
      articleId,
      author: currentUser.username,
      content,
      image: processedImage || null,
      parentId: parentId || null,
      createdAt: now,
      updatedAt: now
    };

    await redis.hset(DB_COMMENTS_HASH, comment.id, JSON.stringify(comment));

    return json({ ok:true, comment }, 201);
  }catch(error){
    console.error('comments POST error:', error);
    return json({ error:'发表评论失败。' }, 500);
  }
}

/* 删除评论 */
export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const url = new URL(context.request.url);
    const commentId = String(url.searchParams.get('id') || '').trim();
    if(!commentId) return json({ error:'缺少评论ID。' }, 400);

    const raw = await redis.hget(DB_COMMENTS_HASH, commentId);
    if(!raw) return json({ error:'评论不存在。' }, 404);

    const comment = JSON.parse(raw);
    const currentUser = auth.user;
    const isOwner = isSiteOwner(currentUser);
    const tags = currentUser.profile?.tags || [];
    const isAuthor = tags.includes('作者') || currentUser.username === comment.author;

    // 权限检查：站主+文章作者可无条件删除他人评论，其他人只能删自己的
    if(currentUser.username === comment.author){
      // 删除自己的评论
    }else if(isOwner){
      // 站主可删除任何评论
    }else{
      // 检查是否为文章作者
      const articleRaw = await redis.hget(DB_ARTICLES_HASH, comment.articleId);
      let isArticleAuthor = false;
      if(articleRaw){
        try{
          const article = JSON.parse(articleRaw);
          isArticleAuthor = article.author === currentUser.username;
        }catch(_){}
      }
      if(!isArticleAuthor){
        return json({ error:'您没有权限删除该评论。' }, 403);
      }
    }

    await redis.hdel(DB_COMMENTS_HASH, commentId);
    return json({ ok:true, deleted:true });
  }catch(error){
    console.error('comments DELETE error:', error);
    return json({ error:'删除评论失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET / POST / DELETE 请求。' }, 405);
}