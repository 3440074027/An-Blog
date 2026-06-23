import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import {
  DB_USERS_HASH,
  DB_VERSIONS_HASH,
  VERSION_FIELDS,
  LEGACY_USER_INDEX_KEY,
  LEGACY_USER_STORE_KEY,
  legacyUserKey,
  legacyVersionKey
} from './db-keys.js';

export const redis = Redis.fromEnv();
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-this-auth-secret-please';
export const SITE_OWNER_USERNAME = 'An';

export {
  DB_USERS_HASH,
  DB_VERSIONS_HASH,
  VERSION_FIELDS
};

export const defaultUserProfile = {
  avatar: '',
  nickname: '',
  signature: '',
  intro: '',
  tags: [],
  texts: {},
  files: [],
  articles: []
};

/* ------------------ 通用工具 ------------------ */
export function json(data, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

export async function readJsonBody(request){
  if(!request) return {};
  if(request.body && typeof request.body === 'object' && !('getReader' in request.body)){
    return request.body;
  }
  if(typeof request.json === 'function'){
    try{
      return await request.json();
    }catch(_){}
  }
  if(typeof request.text === 'function'){
    try{
      const text = await request.text();
      return text ? JSON.parse(text) : {};
    }catch(_){}
  }
  return {};
}

export function getRequestUrl(request){
  return new URL(request.url || 'https://edgeone.local/');
}

export function nowIso(){
  return new Date().toISOString();
}

/* ------------------ 进程内短期缓存 ------------------ */
const _cache = new Map();
function cacheGet(key){
  const entry = _cache.get(key);
  if(!entry) return undefined;
  if(entry.expire && entry.expire < Date.now()){
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}
function cacheSet(key, value, ttlMs = 5000){
  _cache.set(key, { value, expire:Date.now() + ttlMs });
}
function cacheInvalidate(prefix){
  for(const key of _cache.keys()){
    if(key.startsWith(prefix)) _cache.delete(key);
  }
}

/* ------------------ 用户字典遗留兼容 ------------------ */
async function getLegacyUsersDict(){
  const cached = cacheGet('legacy-users-dict');
  if(cached !== undefined) return cached;
  try{
    const users = await redis.get(LEGACY_USER_STORE_KEY);
    const value = users && typeof users === 'object' && !Array.isArray(users) ? users : {};
    cacheSet('legacy-users-dict', value, 8000);
    return value;
  }catch(error){
    console.error('getLegacyUsersDict error:', error);
    return {};
  }
}

async function readLegacyUser(username){
  // 1) user:<username>
  try{
    const direct = await redis.get(legacyUserKey(username));
    if(direct) return direct;
  }catch(_){ }
  // 2) users 字典
  const dict = await getLegacyUsersDict();
  return dict[username] || null;
}

async function migrateUserToHash(user){
  if(!user || !user.username) return;
  try{
    await redis.hset(DB_USERS_HASH, { [user.username]: user });
  }catch(error){
    console.error('migrate user to hash error:', error);
  }
}

/* ------------------ 用户存在性 / 读写 ------------------ */

// 仅判断"用户名是否被注册"，不读完整资料
export async function userExists(username){
  if(!username) return false;
  const cacheKey = `exists:${username}`;
  const cached = cacheGet(cacheKey);
  if(cached !== undefined) return cached;

  // 1) 集中表 db:users（兼容数字 1/0 与字符串 "1"/"0"）
  try{
    const exists = await redis.hexists(DB_USERS_HASH, username);
    if(Number(exists) === 1){
      cacheSet(cacheKey, true, 4000);
      return true;
    }
  }catch(error){
    console.error('userExists hexists error:', error);
  }
  // 2) 旧版 user:<u>
  try{
    const direct = await redis.exists(legacyUserKey(username));
    if(Number(direct) === 1){
      cacheSet(cacheKey, true, 4000);
      return true;
    }
  }catch(error){
    console.error('userExists legacy exists error:', error);
  }
  // 3) 旧版 users 字典
  try{
    const inIndex = await redis.sismember(LEGACY_USER_INDEX_KEY, username);
    if(Number(inIndex) === 1){
      cacheSet(cacheKey, true, 4000);
      return true;
    }
  }catch(_){ }
  const dict = await getLegacyUsersDict();
  if(dict[username]){
    cacheSet(cacheKey, true, 4000);
    return true;
  }
  // 4) 大小写不敏感兜底
  const ciUser = await findUserCaseInsensitive(username);
  if(ciUser){
    cacheSet(cacheKey, true, 4000);
    return true;
  }
  // 注册校验场景下绝不缓存 false（避免短时间窗里给已注册账号挂错状态）
  return false;
}

export async function getUser(username){
  if(!username) return null;
  const cacheKey = `user:${username}`;
  const cached = cacheGet(cacheKey);
  if(cached !== undefined && cached !== null) return cached;

  // 集中表优先
  try{
    const user = await redis.hget(DB_USERS_HASH, username);
    if(user){
      cacheSet(cacheKey, user, 3000);
      return user;
    }
  }catch(error){
    console.error('getUser hget error:', error);
  }

  // 兜底 + 自动迁移
  const legacy = await readLegacyUser(username);
  if(legacy){
    await migrateUserToHash(legacy);
    cacheSet(cacheKey, legacy, 3000);
    return legacy;
  }
  // 大小写不敏感兜底：用户登录时输入大小写不同也能匹配上
  const ciUser = await findUserCaseInsensitive(username);
  if(ciUser){
    cacheSet(`user:${ciUser.username}`, ciUser, 3000);
    return ciUser;
  }
  // 注意：不再缓存 null，避免 1.5s 窗口内"刚注册却查不到"的诡异情况
  return null;
}

/**
 * 大小写不敏感地查找用户（在 db:users 内扫描）。
 * 失败/找不到时返回 null。会用短期缓存避免连续扫描。
 */
export async function findUserCaseInsensitive(username){
  if(!username) return null;
  const lower = String(username).toLowerCase();
  const ciKey = `user-ci:${lower}`;
  const cached = cacheGet(ciKey);
  if(cached !== undefined) return cached || null;
  try{
    const all = await redis.hgetall(DB_USERS_HASH);
    if(all && typeof all === 'object'){
      for(const [name, user] of Object.entries(all)){
        if(name && name.toLowerCase() === lower && user && typeof user === 'object'){
          cacheSet(ciKey, user, 4000);
          return user;
        }
      }
    }
  }catch(error){
    console.error('findUserCaseInsensitive hgetall error:', error);
  }
  // 旧字典兜底
  try{
    const dict = await getLegacyUsersDict();
    for(const [name, user] of Object.entries(dict || {})){
      if(name && name.toLowerCase() === lower && user && typeof user === 'object'){
        cacheSet(ciKey, user, 4000);
        return user;
      }
    }
  }catch(_){ }
  cacheSet(ciKey, null, 1500);
  return null;
}

export function isSiteOwner(userOrUsername){
  const username = typeof userOrUsername === 'string' ? userOrUsername : userOrUsername?.username;
  return username === SITE_OWNER_USERNAME;
}

let _userListCache = null;
let _userListCacheAt = 0;
export async function listUsers({ ttlMs = 6000 } = {}){
  if(_userListCache && Date.now() - _userListCacheAt < ttlMs){
    return _userListCache;
  }
  const users = new Map();
  try{
    const all = await redis.hvals(DB_USERS_HASH);
    if(Array.isArray(all)){
      all.forEach(user=>{
        if(user && user.username) users.set(user.username, user);
      });
    }
  }catch(error){
    console.error('listUsers hvals error:', error);
  }
  // 旧字典兜底（仅在集中表为空或迁移中）
  const dict = await getLegacyUsersDict();
  Object.values(dict).forEach(user=>{
    if(user && user.username && !users.has(user.username)) users.set(user.username, user);
  });
  _userListCache = Array.from(users.values());
  _userListCacheAt = Date.now();
  return _userListCache;
}

export function invalidateListUsersCache(){
  _userListCache = null;
}

export async function setUser(user){
  if(!user || !user.username) return;
  try{
    await redis.hset(DB_USERS_HASH, { [user.username]: user });
  }catch(error){
    console.error('setUser hset error:', error);
    throw error;
  }
  cacheInvalidate(`user:${user.username}`);
  cacheInvalidate(`exists:${user.username}`);
  invalidateListUsersCache();
  await bumpUserVersion(user.username);
}

export async function deleteUser(username){
  if(!username) return;
  try{
    await redis.hdel(DB_USERS_HASH, username);
  }catch(error){
    console.error('deleteUser hdel error:', error);
  }
  // 顺手清理旧键，避免再次"复活"
  try{ await redis.del(legacyUserKey(username)); }catch(_){ }
  try{ await redis.srem(LEGACY_USER_INDEX_KEY, username); }catch(_){ }
  try{
    const dict = await getLegacyUsersDict();
    if(dict[username]){
      delete dict[username];
      await redis.set(LEGACY_USER_STORE_KEY, dict);
    }
  }catch(_){ }
  cacheInvalidate('legacy-users-dict');
  cacheInvalidate(`user:${username}`);
  cacheInvalidate(`exists:${username}`);
  invalidateListUsersCache();
  await bumpUserVersion(username);
}

export async function renameUser(user, nextUsername){
  const previousUsername = user.username;
  user.username = nextUsername;
  if(user.profile && (!user.profile.nickname || user.profile.nickname === previousUsername)){
    user.profile.nickname = nextUsername;
  }
  user.updatedAt = nowIso();
  try{
    await redis.hset(DB_USERS_HASH, { [nextUsername]: user });
    if(previousUsername !== nextUsername){
      await redis.hdel(DB_USERS_HASH, previousUsername);
    }
  }catch(error){
    console.error('renameUser hset/hdel error:', error);
  }
  if(previousUsername !== nextUsername){
    try{ await redis.del(legacyUserKey(previousUsername)); }catch(_){ }
    try{ await redis.srem(LEGACY_USER_INDEX_KEY, previousUsername); }catch(_){ }
    try{
      const dict = await getLegacyUsersDict();
      if(dict[previousUsername]){
        delete dict[previousUsername];
        await redis.set(LEGACY_USER_STORE_KEY, dict);
      }
    }catch(_){ }
  }
  cacheInvalidate('legacy-users-dict');
  cacheInvalidate(`user:${previousUsername}`);
  cacheInvalidate(`user:${nextUsername}`);
  cacheInvalidate(`exists:${previousUsername}`);
  cacheInvalidate(`exists:${nextUsername}`);
  invalidateListUsersCache();
  await Promise.all([bumpUserVersion(previousUsername), bumpUserVersion(nextUsername)]);
  return user;
}

/* ------------------ 校验 / 加密 ------------------ */
export function isValidUsername(username){
  return /^[A-Za-z0-9]{2,20}$/.test(username);
}

export function isValidPassword(password){
  return (
    typeof password === 'string' &&
    password.length >= 6 &&
    password.length <= 64 &&
    /^[A-Za-z0-9!@#$%^&*_\-+=.?]+$/.test(password)
  );
}

export function sanitizeAvatar(avatar){
  if(typeof avatar !== 'string' || !avatar.trim()) return '';
  const value = avatar.trim();
  if(!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value)) return '';
  if(Buffer.byteLength(value, 'utf8') > 500_000) return '';
  return value;
}

export function sanitizeUserProfile(input = {}, username = ''){
  const tags = Array.isArray(input.tags)
    ? input.tags.map(tag=>String(tag).trim()).filter(Boolean).slice(0, 12).map(tag=>tag.slice(0, 24))
    : [];
  const texts = input.texts && typeof input.texts === 'object' && !Array.isArray(input.texts)
    ? Object.fromEntries(
        Object.entries(input.texts)
          .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
          .slice(0, 50)
          .map(([key, value]) => [key.slice(0, 50), value.slice(0, 1000)])
      )
    : {};
  const files = Array.isArray(input.files)
    ? input.files
        .filter(file => file && typeof file === 'object' && !Array.isArray(file))
        .slice(0, 50)
        .map(file => ({
          id: typeof file.id === 'string' ? file.id.slice(0, 80) : crypto.randomUUID(),
          name: typeof file.name === 'string' ? file.name.trim().slice(0, 120) : '',
          type: typeof file.type === 'string' ? file.type.trim().slice(0, 80) : '',
          size: Number.isFinite(Number(file.size)) ? Math.max(0, Number(file.size)) : 0,
          url: typeof file.url === 'string' ? file.url.trim().slice(0, 1000) : '',
          createdAt: typeof file.createdAt === 'string' ? file.createdAt.slice(0, 40) : nowIso()
        }))
        .filter(file => file.name || file.url)
    : [];
  return {
    avatar: sanitizeAvatar(input.avatar),
    nickname: typeof input.nickname === 'string' ? input.nickname.trim().slice(0, 40) : username,
    signature: typeof input.signature === 'string' ? input.signature.trim().slice(0, 120) : '',
    intro: typeof input.intro === 'string' ? input.intro.trim().slice(0, 500) : '',
    tags,
    texts,
    files,
    articles: []
  };
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')){
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, passwordData){
  if(!passwordData || !passwordData.salt || !passwordData.hash) return false;
  const current = hashPassword(password, passwordData.salt).hash;
  return crypto.timingSafeEqual(Buffer.from(current, 'hex'), Buffer.from(passwordData.hash, 'hex'));
}

export function publicUser(user){
  const profile = {
    ...defaultUserProfile,
    nickname: user.username,
    ...(user.profile || {}),
    articles: []
  };
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    profile
  };
}

function base64Url(input){
  return Buffer.from(input).toString('base64url');
}

export function createToken(username){
  const payload = base64Url(JSON.stringify({ username, iat:Date.now() }));
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyToken(token){
  if(typeof token !== 'string' || !token.includes('.')) return '';
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if(Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return '';
  if(!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return '';
  try{
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.username === 'string' ? data.username : '';
  }catch(_){
    return '';
  }
}

export async function requireUser(request){
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const username = verifyToken(token);
  if(!username) return { error:'请先登录。', status:401 };
  const user = await getUser(username);
  if(!user) return { error:'账号不存在，请重新登录。', status:401 };
  return { user };
}

/* ------------------ 版本号 / 实时同步 ------------------
 * 全部存放在 db:versions 这一个 HASH 中，HINCRBY 一次往返。
 */
export async function bumpVersion(field){
  if(!field) return 0;
  try{
    return await redis.hincrby(DB_VERSIONS_HASH, field, 1);
  }catch(error){
    console.error('bumpVersion error:', field, error);
    return 0;
  }
}

export async function bumpAnnouncementsVersion(){
  return bumpVersion(VERSION_FIELDS.announcements);
}

export async function bumpArticlesVersion(){
  return bumpVersion(VERSION_FIELDS.articles);
}

export async function bumpUserVersion(username){
  if(!username) return 0;
  return bumpVersion(VERSION_FIELDS.user(username));
}

export async function bumpMailVersion(username){
  if(!username) return 0;
  return bumpVersion(VERSION_FIELDS.mail(username));
}

export async function bumpFriendsVersion(username){
  if(!username) return 0;
  return bumpVersion(VERSION_FIELDS.friends(username));
}

export async function bumpChatVersion(username){
  if(!username) return 0;
  return bumpVersion(VERSION_FIELDS.chat(username));
}

export async function bumpCommentsVersion(articleId){
  if(!articleId) return 0;
  return bumpVersion(VERSION_FIELDS.comments(articleId));
}

export async function readVersionFields(fields){
  if(!fields || !fields.length) return [];
  try{
    const values = await redis.hmget(DB_VERSIONS_HASH, ...fields);
    const list = Array.isArray(values) ? values : (values && typeof values === 'object' ? fields.map(f=>values[f]) : []);
    let out = list.map(value=>{
      const num = Number(value);
      return Number.isFinite(num) ? num : 0;
    });
    // 兜底：若集中表为 0，再去看一眼旧的 site:version:* 字符串键，方便迁移期数据不丢
    if(out.every(v=>v === 0)){
      try{
        const legacy = await redis.mget(...fields.map(f=>legacyVersionKey(f)));
        out = (Array.isArray(legacy) ? legacy : []).map(value=>{
          const num = Number(value);
          return Number.isFinite(num) ? num : 0;
        });
      }catch(_){ }
    }
    return out;
  }catch(error){
    console.error('readVersionFields error:', error);
    return fields.map(()=>0);
  }
}
