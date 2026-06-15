import {
  json,
  readJsonBody,
  requireUser,
  getUser,
  redis,
  nowIso,
  publicUser,
  SITE_OWNER_USERNAME,
  isSiteOwner,
  bumpFriendsVersion
} from './_lib/auth.js';
import { DB_FRIENDS_HASH } from './_lib/db-keys.js';

/**
 * 好友 API
 * --------------------------------------------------
 * 数据存放在 db:friends HASH，field=username，value=JSON：
 *   {
 *     friends: [username, ...],
 *     incoming: [{ from, message, createdAt }],
 *     outgoing: [{ to, message, createdAt }],
 *     updatedAt
 *   }
 *
 * 站主 An 是所有用户的固定好友（读取时自动注入，不写入存储），
 * 不能被删除、也不需要发送好友申请。
 */

const SITE_OWNER_INTRO = '站主 An——本站的搭建者与守门人。任何用户都可以与 An 直接聊天、咨询、反馈。';

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

function emptyRecord(){
  return { friends:[], incoming:[], outgoing:[], updatedAt:nowIso() };
}

async function readFriendRecord(username){
  if(!username) return emptyRecord();
  const raw = await redis.hget(DB_FRIENDS_HASH, username);
  const value = parseStoredJson(raw, null);
  if(!value) return emptyRecord();
  return {
    friends: Array.isArray(value.friends) ? value.friends.filter(name => typeof name === 'string') : [],
    incoming: Array.isArray(value.incoming) ? value.incoming.filter(r => r && typeof r === 'object' && r.from) : [],
    outgoing: Array.isArray(value.outgoing) ? value.outgoing.filter(r => r && typeof r === 'object' && r.to) : [],
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : nowIso()
  };
}

async function writeFriendRecord(username, record){
  const payload = {
    friends: Array.from(new Set((record.friends || []).filter(Boolean))),
    incoming: (record.incoming || []).slice(0, 200),
    outgoing: (record.outgoing || []).slice(0, 200),
    updatedAt: nowIso()
  };
  await redis.hset(DB_FRIENDS_HASH, { [username]: JSON.stringify(payload) });
  return payload;
}

function makeOwnerProfileSummary(ownerUser = null){
  const profile = ownerUser?.profile || {};
  return {
    username: SITE_OWNER_USERNAME,
    profile: {
      avatar: profile.avatar || '',
      nickname: profile.nickname || '站主 An',
      signature: profile.signature || '本站站主，欢迎随时来聊。',
      intro: profile.intro || SITE_OWNER_INTRO,
      tags: Array.isArray(profile.tags) && profile.tags.length ? profile.tags : ['站主', '官方', '客服'],
      isOwner: true
    },
    isOwner: true,
    description: SITE_OWNER_INTRO
  };
}

async function summarizeUser(username){
  if(!username) return null;
  if(username === SITE_OWNER_USERNAME){
    const owner = await getUser(SITE_OWNER_USERNAME).catch(()=>null);
    return makeOwnerProfileSummary(owner);
  }
  const user = await getUser(username);
  if(!user) return { username, profile:{ nickname:username }, missing:true };
  const pub = publicUser(user);
  return {
    username: pub.username,
    profile: {
      avatar: pub.profile?.avatar || '',
      nickname: pub.profile?.nickname || pub.username,
      signature: pub.profile?.signature || '',
      tags: Array.isArray(pub.profile?.tags) ? pub.profile.tags : []
    },
    isOwner: pub.username === SITE_OWNER_USERNAME
  };
}

async function buildResponse(currentUser){
  const me = currentUser.username;
  const record = await readFriendRecord(me);
  // 注入"站主 An"作为固定好友（自己若是站主则跳过）
  const friendUsernames = new Set(record.friends);
  if(!isSiteOwner(currentUser)) friendUsernames.add(SITE_OWNER_USERNAME);

  const friends = (await Promise.all(Array.from(friendUsernames).map(summarizeUser)))
    .filter(Boolean)
    .sort((a, b) => {
      if(a.username === SITE_OWNER_USERNAME && b.username !== SITE_OWNER_USERNAME) return -1;
      if(b.username === SITE_OWNER_USERNAME && a.username !== SITE_OWNER_USERNAME) return 1;
      return 0;
    });
  const incoming = await Promise.all(record.incoming.map(async r => ({
    from: r.from,
    message: r.message || '',
    createdAt: r.createdAt || '',
    user: await summarizeUser(r.from)
  })));
  const outgoing = await Promise.all(record.outgoing.map(async r => ({
    to: r.to,
    message: r.message || '',
    createdAt: r.createdAt || '',
    user: await summarizeUser(r.to)
  })));

  return {
    ok: true,
    siteOwner: {
      username: SITE_OWNER_USERNAME,
      description: SITE_OWNER_INTRO,
      profile: friends.find(item => item.username === SITE_OWNER_USERNAME)?.profile || null,
      avatar: friends.find(item => item.username === SITE_OWNER_USERNAME)?.profile?.avatar || ''
    },
    friends,
    incoming,
    outgoing,
    updatedAt: record.updatedAt
  };
}

/* ---------------- HTTP 处理 ---------------- */

export async function onRequestGet(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    return json(await buildResponse(auth.user));
  }catch(error){
    console.error('friends get error:', error);
    return json({ error:'读取好友列表失败。' }, 500);
  }
}

// 发送好友申请
export async function onRequestPost(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const to = String(body.to || '').trim();
    const message = String(body.message || '').trim().slice(0, 200);
    if(!to) return json({ error:'请填写要添加的用户名。' }, 400);
    if(to === auth.user.username) return json({ error:'不能添加自己为好友。' }, 400);
    if(to === SITE_OWNER_USERNAME) return json({ error:'站主 An 是默认好友，无需申请。' }, 400);

    const target = await getUser(to);
    if(!target) return json({ error:'目标用户不存在。' }, 404);

    const me = auth.user.username;
    const myRecord = await readFriendRecord(me);
    const tgRecord = await readFriendRecord(target.username);

    if(myRecord.friends.includes(target.username) || tgRecord.friends.includes(me)){
      return json({ error:'你们已经是好友了。' }, 409);
    }
    if(myRecord.outgoing.some(r => r.to === target.username)){
      return json({ error:'已向该用户发送过申请，等待对方处理。' }, 409);
    }
    // 如果对方已经向我发过申请，则直接成为好友
    const reverseIncoming = myRecord.incoming.find(r => r.from === target.username);
    if(reverseIncoming){
      myRecord.incoming = myRecord.incoming.filter(r => r.from !== target.username);
      tgRecord.outgoing = tgRecord.outgoing.filter(r => r.to !== me);
      myRecord.friends = Array.from(new Set([...myRecord.friends, target.username]));
      tgRecord.friends = Array.from(new Set([...tgRecord.friends, me]));
      await Promise.all([
        writeFriendRecord(me, myRecord),
        writeFriendRecord(target.username, tgRecord)
      ]);
      await Promise.all([
        bumpFriendsVersion(me),
        bumpFriendsVersion(target.username)
      ]);
      return json({ ok:true, accepted:true });
    }

    const createdAt = nowIso();
    myRecord.outgoing = [{ to: target.username, message, createdAt }, ...myRecord.outgoing.filter(r => r.to !== target.username)].slice(0, 200);
    tgRecord.incoming = [{ from: me, message, createdAt }, ...tgRecord.incoming.filter(r => r.from !== me)].slice(0, 200);
    await Promise.all([
      writeFriendRecord(me, myRecord),
      writeFriendRecord(target.username, tgRecord)
    ]);
    await Promise.all([
      bumpFriendsVersion(me),
      bumpFriendsVersion(target.username)
    ]);
    return json({ ok:true, sent:true });
  }catch(error){
    console.error('friends post error:', error);
    return json({ error:'发送好友申请失败。' }, 500);
  }
}

// 同意好友申请
export async function onRequestPut(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const from = String(body.from || '').trim();
    if(!from) return json({ error:'缺少申请人用户名。' }, 400);

    const me = auth.user.username;
    const myRecord = await readFriendRecord(me);
    const fromRecord = await readFriendRecord(from);

    if(!myRecord.incoming.some(r => r.from === from)){
      // 兼容直接同意（对方仍在 outgoing 中）
      if(!fromRecord.outgoing.some(r => r.to === me)){
        return json({ error:'未找到该好友申请。' }, 404);
      }
    }

    myRecord.incoming = myRecord.incoming.filter(r => r.from !== from);
    fromRecord.outgoing = fromRecord.outgoing.filter(r => r.to !== me);
    myRecord.friends = Array.from(new Set([...myRecord.friends, from]));
    fromRecord.friends = Array.from(new Set([...fromRecord.friends, me]));

    await Promise.all([
      writeFriendRecord(me, myRecord),
      writeFriendRecord(from, fromRecord)
    ]);
    await Promise.all([
      bumpFriendsVersion(me),
      bumpFriendsVersion(from)
    ]);
    return json({ ok:true, accepted:true });
  }catch(error){
    console.error('friends put error:', error);
    return json({ error:'同意好友申请失败。' }, 500);
  }
}

// 删除好友 / 拒绝申请 / 取消申请
export async function onRequestDelete(context){
  const auth = await requireUser(context.request);
  if(auth.error) return json({ error:auth.error }, auth.status);
  try{
    const body = await readJsonBody(context.request);
    const action = String(body.action || '').trim(); // 'reject' | 'cancel' | 'unfriend'
    const target = String(body.target || body.from || body.to || body.username || '').trim();
    if(!target) return json({ error:'缺少目标用户名。' }, 400);
    if(target === SITE_OWNER_USERNAME && action === 'unfriend'){
      return json({ error:'不能删除站主 An。' }, 400);
    }

    const me = auth.user.username;
    const myRecord = await readFriendRecord(me);
    const otherRecord = await readFriendRecord(target);

    if(action === 'reject'){
      myRecord.incoming = myRecord.incoming.filter(r => r.from !== target);
      otherRecord.outgoing = otherRecord.outgoing.filter(r => r.to !== me);
    }else if(action === 'cancel'){
      myRecord.outgoing = myRecord.outgoing.filter(r => r.to !== target);
      otherRecord.incoming = otherRecord.incoming.filter(r => r.from !== me);
    }else{ // unfriend (默认)
      myRecord.friends = myRecord.friends.filter(name => name !== target);
      otherRecord.friends = otherRecord.friends.filter(name => name !== me);
    }

    await Promise.all([
      writeFriendRecord(me, myRecord),
      writeFriendRecord(target, otherRecord)
    ]);
    await Promise.all([
      bumpFriendsVersion(me),
      bumpFriendsVersion(target)
    ]);
    return json({ ok:true });
  }catch(error){
    console.error('friends delete error:', error);
    return json({ error:'操作好友失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET、POST、PUT 或 DELETE 请求。' }, 405);
}

/* 工具：给其他模块用 */
export async function isFriendOrOwner(meUsername, otherUsername){
  if(!meUsername || !otherUsername) return false;
  if(meUsername === otherUsername) return false;
  if(meUsername === SITE_OWNER_USERNAME || otherUsername === SITE_OWNER_USERNAME) return true;
  const myRecord = await readFriendRecord(meUsername);
  return myRecord.friends.includes(otherUsername);
}
