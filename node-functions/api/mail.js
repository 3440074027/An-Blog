import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  getUser,
  redis,
  nowIso,
  isSiteOwner,
  SITE_OWNER_USERNAME,
  bumpMailVersion
} from './_lib/auth.js';
import {
  DB_MAILS_HASH,
  legacyMailboxKey,
  legacyInboxKey,
  legacySentKey
} from './_lib/db-keys.js';

const MAIL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_DATA_LENGTH = 14 * 1024 * 1024;

function parseStoredJson(value, fallback){
  if(!value) return fallback;
  if(typeof value === 'object') return value;
  if(typeof value === 'string'){
    try{
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    }catch(_){
      return fallback;
    }
  }
  return fallback;
}

function isExpired(mail){
  const created = Date.parse(mail.createdAt || '');
  return Number.isFinite(created) && Date.now() - created > MAIL_TTL_MS;
}

function sanitizeAttachment(attachment){
  if(!attachment || typeof attachment !== 'object') return null;
  const size = Number(attachment.size || 0);
  const data = String(attachment.data || '');
  if(!data) return null;
  if(size > MAX_ATTACHMENT_BYTES || data.length > MAX_TOTAL_DATA_LENGTH){
    const error = new Error('附件不能超过 10MB。');
    error.status = 400;
    throw error;
  }
  return {
    name: String(attachment.name || '附件').trim().slice(0, 120),
    type: String(attachment.type || 'application/octet-stream').trim().slice(0, 120),
    size,
    data,
    kind: String(attachment.kind || '').trim().slice(0, 40)
  };
}

function sanitizeAttachments(attachments){
  if(!Array.isArray(attachments)) return [];
  const list = attachments
    .map(item=>sanitizeAttachment(item))
    .filter(Boolean)
    .slice(0, 12);
  const totalSize = list.reduce((sum, item)=>sum + Number(item.size || 0), 0);
  const totalDataLength = list.reduce((sum, item)=>sum + String(item.data || '').length, 0);
  if(totalSize > MAX_ATTACHMENT_BYTES || totalDataLength > MAX_TOTAL_DATA_LENGTH){
    const error = new Error('附件总大小不能超过 10MB。');
    error.status = 400;
    throw error;
  }
  return list;
}

function sanitizeMail(mail){
  return {
    id: typeof mail.id === 'string' ? mail.id : crypto.randomUUID(),
    from: String(mail.from || '').trim().slice(0, 20),
    to: String(mail.to || '').trim().slice(0, 20),
    subject: String(mail.subject || '').trim().slice(0, 80),
    body: String(mail.body || '').trim().slice(0, 240000),
    createdAt: typeof mail.createdAt === 'string' ? mail.createdAt : nowIso(),
    expiresAt: typeof mail.expiresAt === 'string' ? mail.expiresAt : new Date(Date.now() + MAIL_TTL_MS).toISOString(),
    read: Boolean(mail.read),
    attachment: sanitizeAttachment(mail.attachment),
    attachments: sanitizeAttachments(mail.attachments)
  };
}

// 一次性读取用户邮箱：优先读集中表 db:mails，失败再回退到老键并自动迁移
async function readUserMailbox(username){
  const box = parseStoredJson(await redis.hget(DB_MAILS_HASH, username), null);
  if(box){
    const inbox = Array.isArray(box.inbox) ? box.inbox.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
    const sent = Array.isArray(box.sent) ? box.sent.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
    // 如果有过期项，刷一次（不阻塞返回结果）
    if((inbox.length !== (box.inbox?.length || 0)) || (sent.length !== (box.sent?.length || 0))){
      await writeUserMailbox(username, { inbox, sent }, { skipBump:true });
    }
    return { inbox, sent };
  }

  // 旧版兜底：先读 mail:box:<u>，再读 inbox/sent 分离键
  const legacyBox = parseStoredJson(await redis.get(legacyMailboxKey(username)), null);
  if(legacyBox){
    const inbox = Array.isArray(legacyBox.inbox) ? legacyBox.inbox.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
    const sent = Array.isArray(legacyBox.sent) ? legacyBox.sent.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
    await writeUserMailbox(username, { inbox, sent }, { skipBump:true });
    return { inbox, sent };
  }
  const [legacyInbox, legacySent] = await redis.mget(legacyInboxKey(username), legacySentKey(username));
  const inbox = Array.isArray(legacyInbox) ? legacyInbox.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
  const sent = Array.isArray(legacySent) ? legacySent.map(sanitizeMail).filter(item=>!isExpired(item)) : [];
  await writeUserMailbox(username, { inbox, sent }, { skipBump:true });
  return { inbox, sent };
}

async function writeUserMailbox(username, box, { skipBump = false } = {}){
  const payload = {
    inbox:(box.inbox || []).map(sanitizeMail).filter(item=>!isExpired(item)).slice(0, 100),
    sent:(box.sent || []).map(sanitizeMail).filter(item=>!isExpired(item)).slice(0, 100),
    updatedAt:nowIso()
  };
  await redis.hset(DB_MAILS_HASH, { [username]: JSON.stringify(payload) });
  if(!skipBump) await bumpMailVersion(username);
}

async function addUserMail(username, boxName, mail){
  const box = await readUserMailbox(username);
  box[boxName] = [mail, ...(box[boxName] || [])].slice(0, 100);
  await writeUserMailbox(username, box);
}

export async function onRequestGet(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  try{
    const { inbox, sent } = await readUserMailbox(auth.user.username);
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
      attachment: body.attachment || null,
      attachments: body.attachments || []
    });
    if(!mail.body && !mail.attachment && !mail.attachments.length){
      return json({ error:'邮件内容或附件至少填写一项。' }, 400);
    }
    await Promise.all([
      addUserMail(target.username, 'inbox', mail),
      addUserMail(auth.user.username, 'sent', { ...mail, read:true })
    ]);
    return json({ ok:true, mail });
  }catch(error){
    console.error('mail send error:', error);
    return json({ error:error.message || '发送邮件失败。' }, error.status || 500);
  }
}

export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  try{
    const body = await readJsonBody(context.request);
    const id = String(body.id || '').trim();
    if(!id) return json({ error:'缺少邮件 ID。' }, 400);
    const box = await readUserMailbox(auth.user.username);
    const nextInbox = box.inbox.map(mail => mail.id === id ? { ...mail, read:true } : mail);
    await writeUserMailbox(auth.user.username, { ...box, inbox:nextInbox });
    const mail = nextInbox.find(item=>item.id === id) || null;
    return json({ ok:true, mail });
  }catch(error){
    console.error('mail update error:', error);
    return json({ error:error.message || '更新邮件状态失败。' }, error.status || 500);
  }
}

export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error){
    return json({ error:auth.error }, auth.status);
  }
  try{
    const body = await readJsonBody(context.request);
    const id = String(body.id || '').trim();
    const box = String(body.box || 'inbox').trim();
    if(!id) return json({ error:'缺少邮件 ID。' }, 400);
    const userBox = await readUserMailbox(auth.user.username);
    const items = box === 'sent' ? userBox.sent : userBox.inbox;
    const nextItems = items.filter(mail => mail.id !== id);
    await writeUserMailbox(auth.user.username, {
      ...userBox,
      [box === 'sent' ? 'sent' : 'inbox']:nextItems
    });
    return json({ ok:true, deleted:items.length - nextItems.length });
  }catch(error){
    console.error('mail delete error:', error);
    return json({ error:error.message || '删除邮件失败。' }, error.status || 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
