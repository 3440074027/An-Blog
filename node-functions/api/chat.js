import crypto from 'crypto';
import {
  json,
  readJsonBody,
  requireUser,
  getUser,
  redis,
  nowIso,
  SITE_OWNER_USERNAME,
  isSiteOwner,
  bumpChatVersion
} from './_lib/auth.js';
import {
  DB_CHATS_HASH,
  DB_FRIENDS_HASH,
  conversationIdOf
} from './_lib/db-keys.js';

/**
 * 聊天 API
 * --------------------------------------------------
 * GET    /api/chat              获取所有会话摘要 + 未读数
 * GET    /api/chat?with=<u>     获取与某用户的完整消息列表
 * POST   /api/chat              发送消息 { to, body, attachments? }
 * PUT    /api/chat              标记会话已读 { with }
 * DELETE /api/chat              删除会话或单条消息 { with, id? }
 *
 * 数据：db:chats HASH，field=conversationId（双方用户名按字典序拼接），
 * value={ a, b, messages:[...], reads:{u: lastReadId}, updatedAt } 的 JSON 字符串。
 *
 * 业务规则：仅允许"好友"或"任意用户↔站主 An"互发消息。
 */

const MAX_MESSAGES_PER_CONV = 500;
const MAX_BODY_LEN = 4000;
// Upstash 请求体限制约 10MB。文件会以 base64 dataURL 存入消息体，
// 这里保守限制编码后的附件总量，避免刚好触顶导致整条请求失败。
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 6;

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

async function readFriendsList(username){
  const raw = await redis.hget(DB_FRIENDS_HASH, username);
  const value = parseStoredJson(raw, null);
  return Array.isArray(value?.friends) ? value.friends : [];
}

async function ensureCanChat(me, otherUsername){
  if(!otherUsername) return { ok:false, error:'缺少对方用户名。', status:400 };
  if(otherUsername === me.username) return { ok:false, error:'不能给自己发消息。', status:400 };
  // 站主可以和任何人聊天
  if(isSiteOwner(me) || otherUsername === SITE_OWNER_USERNAME) return { ok:true };
  const myFriends = await readFriendsList(me.username);
  if(myFriends.includes(otherUsername)) return { ok:true };
  return { ok:false, error:'你们还不是好友，请先发送好友申请。', status:403 };
}

async function readConversation(a, b){
  const id = conversationIdOf(a, b);
  if(!id) return null;
  const raw = await redis.hget(DB_CHATS_HASH, id);
  const value = parseStoredJson(raw, null);
  if(!value){
    return { id, a:[a, b].sort()[0], b:[a, b].sort()[1], messages:[], reads:{}, updatedAt:'' };
  }
  return {
    id,
    a: value.a || [a, b].sort()[0],
    b: value.b || [a, b].sort()[1],
    messages: Array.isArray(value.messages) ? value.messages : [],
    reads: value.reads && typeof value.reads === 'object' ? value.reads : {},
    updatedAt: value.updatedAt || ''
  };
}

async function writeConversation(conv){
  const payload = {
    a: conv.a,
    b: conv.b,
    messages: (conv.messages || []).slice(-MAX_MESSAGES_PER_CONV),
    reads: conv.reads || {},
    updatedAt: nowIso()
  };
  await redis.hset(DB_CHATS_HASH, { [conv.id]: JSON.stringify(payload) });
  return payload;
}

function sanitizeAttachments(attachments){
  if(!Array.isArray(attachments)) return [];
  if(attachments.length > MAX_ATTACHMENT_COUNT){
    const error = new Error(`一次最多上传 ${MAX_ATTACHMENT_COUNT} 个文件。`);
    error.status = 400;
    throw error;
  }
  const list = attachments.map(att => {
    if(!att || typeof att !== 'object'){
      const error = new Error('附件格式不正确。');
      error.status = 400;
      throw error;
    }
    const data = String(att.data || '');
    const size = Number(att.size || 0);
    const name = String(att.name || '附件').trim().slice(0, 120);
    if(!data){
      const error = new Error(`「${name}」没有读取到文件内容。`);
      error.status = 400;
      throw error;
    }
    if(data.length > MAX_ATTACHMENT_BYTES){
      const error = new Error(`「${name}」编码后超过 Upstash 单次上传安全限制，请压缩后再上传。`);
      error.status = 400;
      throw error;
    }
    return {
      id: typeof att.id === 'string' ? att.id : crypto.randomUUID(),
      name,
      type: String(att.type || 'application/octet-stream').trim().slice(0, 120),
      size: Number.isFinite(size) ? Math.max(0, size) : 0,
      data,
      kind: String(att.kind || '').trim().slice(0, 40)
    };
  });
  const total = list.reduce((s, it)=>s + (it.data?.length || 0), 0);
  if(total > MAX_ATTACHMENT_BYTES){
    const error = new Error('附件总大小超过 Upstash 单次上传安全限制，请减少文件数量或压缩后再发送。');
    error.status = 400;
    throw error;
  }
  return list;
}

function summarizeConversation(conv, me){
  const other = conv.a === me ? conv.b : conv.a;
  const last = conv.messages[conv.messages.length - 1] || null;
  const lastReadId = (conv.reads && conv.reads[me]) || '';
  let unread = 0;
  if(lastReadId){
    const idx = conv.messages.findIndex(m => m.id === lastReadId);
    if(idx >= 0){
      unread = conv.messages.slice(idx + 1).filter(m => m.from !== me).length;
    }else{
      unread = conv.messages.filter(m => m.from !== me).length;
    }
  }else{
    unread = conv.messages.filter(m => m.from !== me).length;
  }
  return {
    id: conv.id,
    other,
    lastMessage: last ? {
      id: last.id,
      from: last.from,
      to: last.to,
      body: last.body,
      hasAttachments: Array.isArray(last.attachments) && last.attachments.length > 0,
      createdAt: last.createdAt
    } : null,
    unread,
    updatedAt: conv.updatedAt
  };
}

async function readAllConversationsForUser(me){
  // 我方好友 + 站主固定列出（即使无消息也作为可发起聊天对象）
  const friends = await readFriendsList(me);
  const targets = new Set(friends);
  if(me !== SITE_OWNER_USERNAME) targets.add(SITE_OWNER_USERNAME);

  const result = [];
  // 通过 hgetall 找出该用户实际存在的会话（更高效）
  let allConversations = {};
  try{
    allConversations = (await redis.hgetall(DB_CHATS_HASH)) || {};
  }catch(error){
    console.error('chat hgetall error:', error);
    allConversations = {};
  }
  const seen = new Set();
  for(const [id, raw] of Object.entries(allConversations)){
    const conv = parseStoredJson(raw, null);
    if(!conv) continue;
    if(conv.a !== me && conv.b !== me) continue;
    const fixedConv = {
      id,
      a: conv.a,
      b: conv.b,
      messages: Array.isArray(conv.messages) ? conv.messages : [],
      reads: conv.reads || {},
      updatedAt: conv.updatedAt || ''
    };
    const summary = summarizeConversation(fixedConv, me);
    seen.add(summary.other);
    result.push(summary);
  }
  // 把没有消息的目标也加进来（包含站主 An）
  for(const t of targets){
    if(seen.has(t)) continue;
    result.push({
      id: conversationIdOf(me, t),
      other: t,
      lastMessage: null,
      unread: 0,
      updatedAt: ''
    });
  }
  // 按最新时间倒序，但站主置顶
  result.sort((x, y) => {
    if(x.other === SITE_OWNER_USERNAME && y.other !== SITE_OWNER_USERNAME) return -1;
    if(y.other === SITE_OWNER_USERNAME && x.other !== SITE_OWNER_USERNAME) return 1;
    return String(y.updatedAt || '').localeCompare(String(x.updatedAt || ''));
  });
  return result;
}

async function summarizePeerProfile(username){
  if(!username) return null;
  if(username === SITE_OWNER_USERNAME){
    return {
      username: SITE_OWNER_USERNAME,
      nickname: '站主 An',
      avatar: '',
      isOwner: true,
      description: '站主 An——本站的搭建者与守门人，欢迎来聊。'
    };
  }
  const user = await getUser(username);
  if(!user) return { username, nickname:username, avatar:'', missing:true };
  return {
    username: user.username,
    nickname: user.profile?.nickname || user.username,
    avatar: user.profile?.avatar || '',
    isOwner: user.username === SITE_OWNER_USERNAME
  };
}

/* ------------------ HTTP 处理 ------------------ */

export async function onRequestGet(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const url = new URL(context.request.url);
    const withUser = String(url.searchParams.get('with') || '').trim();
    const me = auth.user.username;

    if(withUser){
      const conv = await readConversation(me, withUser);
      const peer = await summarizePeerProfile(withUser);
      return json({
        ok:true,
        conversation:{
          id: conv.id,
          other: withUser,
          messages: conv.messages,
          reads: conv.reads,
          updatedAt: conv.updatedAt
        },
        peer
      });
    }

    const conversations = await readAllConversationsForUser(me);
    // 同步给前端每个对方用户的头像/昵称（不带正文）
    const peers = await Promise.all(conversations.map(c => summarizePeerProfile(c.other)));
    return json({
      ok:true,
      conversations,
      peers: peers.filter(Boolean)
    });
  }catch(error){
    console.error('chat get error:', error);
    return json({ error:'读取聊天数据失败。' }, 500);
  }
}

export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const to = String(body.to || '').trim();
    const text = String(body.body || '').trim().slice(0, MAX_BODY_LEN);
    const attachments = sanitizeAttachments(body.attachments);
    if(!to) return json({ error:'缺少接收方用户名。' }, 400);
    if(!text && !attachments.length) return json({ error:'消息内容不能为空。' }, 400);

    const target = await getUser(to);
    if(!target && to !== SITE_OWNER_USERNAME){
      return json({ error:'目标用户不存在。' }, 404);
    }
    const peerUsername = target ? target.username : SITE_OWNER_USERNAME;
    const can = await ensureCanChat(auth.user, peerUsername);
    if(!can.ok) return json({ error:can.error }, can.status);

    const conv = await readConversation(auth.user.username, peerUsername);
    const message = {
      id: crypto.randomUUID(),
      from: auth.user.username,
      to: peerUsername,
      body: text,
      attachments,
      createdAt: nowIso()
    };
    conv.messages = [...conv.messages, message].slice(-MAX_MESSAGES_PER_CONV);
    // 发信人自动算已读
    conv.reads = { ...conv.reads, [auth.user.username]: message.id };
    await writeConversation(conv);
    await Promise.all([
      bumpChatVersion(auth.user.username),
      bumpChatVersion(peerUsername)
    ]);
    return json({ ok:true, message });
  }catch(error){
    console.error('chat post error:', error);
    return json({ error: error.message || '发送消息失败。' }, error.status || 500);
  }
}

// 标记会话已读
export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const withUser = String(body.with || '').trim();
    if(!withUser) return json({ error:'缺少对方用户名。' }, 400);
    const conv = await readConversation(auth.user.username, withUser);
    const last = conv.messages[conv.messages.length - 1];
    if(last){
      conv.reads = { ...conv.reads, [auth.user.username]: last.id };
      await writeConversation(conv);
      await bumpChatVersion(auth.user.username);
    }
    return json({ ok:true });
  }catch(error){
    console.error('chat put error:', error);
    return json({ error:'标记已读失败。' }, 500);
  }
}

export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const withUser = String(body.with || '').trim();
    const messageId = String(body.id || '').trim();
    if(!withUser) return json({ error:'缺少对方用户名。' }, 400);

    const conv = await readConversation(auth.user.username, withUser);
    if(messageId){
      // 仅允许删除自己发的消息
      const before = conv.messages.length;
      conv.messages = conv.messages.filter(m => !(m.id === messageId && m.from === auth.user.username));
      if(conv.messages.length === before){
        return json({ error:'未找到可删除的消息（仅能删除自己发送的）。' }, 404);
      }
      await writeConversation(conv);
    }else{
      // 清空整个会话（双方都看不到了）
      conv.messages = [];
      conv.reads = {};
      await writeConversation(conv);
    }
    await Promise.all([
      bumpChatVersion(auth.user.username),
      bumpChatVersion(withUser)
    ]);
    return json({ ok:true });
  }catch(error){
    console.error('chat delete error:', error);
    return json({ error:'删除失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}
