import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  getUser,
  redis,
  nowIso,
  isSiteOwner,
  SITE_OWNER_USERNAME
} from './_lib/auth.js';

const inboxKey = username => `mail:inbox:${username}`;
const sentKey = username => `mail:sent:${username}`;
const MAIL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isExpired(mail){
  const created = Date.parse(mail.createdAt || '');
  return Number.isFinite(created) && Date.now() - created > MAIL_TTL_MS;
}

function sanitizeAttachment(attachment){
  if(!attachment || typeof attachment !== 'object') return null;
  const size = Number(attachment.size || 0);
  const data = String(attachment.data || '');
  if(!data) return null;
  if(size > MAX_ATTACHMENT_BYTES || data.length > 14 * 1024 * 1024){
    const error = new Error('附件不能超过 10MB。');
    error.status = 400;
    throw error;
  }
  return {
    name: String(attachment.name || '附件').trim().slice(0, 120),
    type: String(attachment.type || 'application/octet-stream').trim().slice(0, 120),
    size,
    data
  };
}

function sanitizeMail(mail){
  return {
    id: typeof mail.id === 'string' ? mail.id : crypto.randomUUID(),
    from: String(mail.from || '').trim().slice(0, 20),
    to: String(mail.to || '').trim().slice(0, 20),
    subject: String(mail.subject || '').trim().slice(0, 80),
    body: String(mail.body || '').trim().slice(0, 1200),
    createdAt: typeof mail.createdAt === 'string' ? mail.createdAt : nowIso(),
    expiresAt: typeof mail.expiresAt === 'string' ? mail.expiresAt : new Date(Date.now() + MAIL_TTL_MS).toISOString(),
    read: Boolean(mail.read),
    attachment: sanitizeAttachment(mail.attachment)
  };
}

async function readMailbox(key){
  const items = await redis.get(key);
  const all = Array.isArray(items) ? items.map(sanitizeMail) : [];
  const active = all.filter(item => !isExpired(item));
  if(active.length !== all.length){
    await redis.set(key, active);
  }
  return active;
}

async function prependMailboxItem(key, item){
  const items = await readMailbox(key);
  items.unshift(item);
  await redis.set(key, items.slice(0, 100));
}

export async function onRequestGet(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  try{
    const [inbox, sent] = await Promise.all([
      readMailbox(inboxKey(auth.user.username)),
      readMailbox(sentKey(auth.user.username))
    ]);
    return json({ ok:true, inbox, sent });
  }catch(error){
    console.error('mail get error:', error);
    return json({ error:'读取邮件失败。' }, 500);
  }
}

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  try{
    const body = await readJsonBody(context.request);
    const to = String(body.to || '').trim();
    const target = await getUser(to);
    if(!target){
      return json({ error:'收件用户不存在，请检查用户名。' }, 404);
    }
    if(to === auth.user.username){
      return json({ error:'不能给自己发送站内邮件。' }, 400);
    }
    const senderIsOwner = isSiteOwner(auth.user);
    const targetIsOwner = target.username === SITE_OWNER_USERNAME;
    if(!senderIsOwner && !targetIsOwner){
      return json({ error:'站内邮件仅支持用户与站主 An 之间互发。' }, 403);
    }
    const mail = sanitizeMail({
      id: crypto.randomUUID(),
      from: auth.user.username,
      to: target.username,
      subject: body.subject || '来自博客站内信',
      body: body.body || '',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + MAIL_TTL_MS).toISOString(),
      read: false,
      attachment: body.attachment || null
    });
    if(!mail.body && !mail.attachment){
      return json({ error:'邮件内容或附件至少填写一项。' }, 400);
    }
    await Promise.all([
      prependMailboxItem(inboxKey(target.username), mail),
      prependMailboxItem(sentKey(auth.user.username), { ...mail, read:true })
    ]);
    return json({ ok:true, mail });
  }catch(error){
    console.error('mail send error:', error);
    return json({ error:error.message || '发送邮件失败。' }, error.status || 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 或 POST 请求。' }, 405);
}
