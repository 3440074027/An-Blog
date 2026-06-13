import { Redis } from '@upstash/redis';
import crypto from 'crypto';

export const redis = Redis.fromEnv();
const AUTH_SECRET = process.env.AUTH_SECRET || 'change-this-auth-secret-please';
const LEGACY_USER_STORE_KEY = 'users';
const USER_KEY_PREFIX = 'user:';
const USER_INDEX_KEY = 'site:user-index';
export const SITE_OWNER_USERNAME = 'An';

export const defaultUserProfile = {
  avatar: '',
  nickname: '',
  signature: '',
  intro: '',
  tags: [],
  texts: {},
  files: []
};

export function json(data, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
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

async function getUsers(){
  const users = await redis.get(LEGACY_USER_STORE_KEY);
  return users && typeof users === 'object' && !Array.isArray(users) ? users : {};
}

async function setLegacyUsers(users){
  await redis.set(LEGACY_USER_STORE_KEY, users);
}

export async function getUser(username){
  const user = await redis.get(`${USER_KEY_PREFIX}${username}`);
  if(user) return user;

  const legacyUsers = await getUsers();
  const legacyUser = legacyUsers[username];
  if(legacyUser){
    await setUser(legacyUser);
    return legacyUser;
  }
  return null;
}

export function isSiteOwner(userOrUsername){
  const username = typeof userOrUsername === 'string' ? userOrUsername : userOrUsername?.username;
  return username === SITE_OWNER_USERNAME;
}

export async function listUsers(){
  const users = new Map();
  try{
    const indexedUsernames = await redis.smembers(USER_INDEX_KEY);
    for(const username of indexedUsernames.slice(0, 500)){
      const user = await getUser(username);
      if(user && user.username) users.set(user.username, user);
    }
  }catch(error){
    console.error('list indexed users error:', error);
  }
  try{
    const keys = await redis.keys(`${USER_KEY_PREFIX}*`);
    for(const key of keys.slice(0, 300)){
      const user = await redis.get(key);
      if(user && user.username) users.set(user.username, user);
    }
  }catch(error){
    console.error('list user keys error:', error);
  }
  const legacyUsers = await getUsers();
  Object.values(legacyUsers).forEach(user=>{
    if(user && user.username && !users.has(user.username)) users.set(user.username, user);
  });
  return Array.from(users.values());
}

export async function setUser(user){
  await redis.set(`${USER_KEY_PREFIX}${user.username}`, user);
  try{
    await redis.sadd(USER_INDEX_KEY, user.username);
  }catch(error){
    console.error('user index add error:', error);
  }
}

export async function deleteUser(username){
  await redis.del(`${USER_KEY_PREFIX}${username}`);
  try{
    await redis.srem(USER_INDEX_KEY, username);
  }catch(error){
    console.error('user index remove error:', error);
  }
  const legacyUsers = await getUsers();
  if(legacyUsers[username]){
    delete legacyUsers[username];
    await setLegacyUsers(legacyUsers);
  }
}

export async function renameUser(user, nextUsername){
  const previousUsername = user.username;
  user.username = nextUsername;
  if(user.profile && (!user.profile.nickname || user.profile.nickname === previousUsername)){
    user.profile.nickname = nextUsername;
  }
  user.updatedAt = nowIso();
  await redis.set(`${USER_KEY_PREFIX}${nextUsername}`, user);
  try{
    await redis.sadd(USER_INDEX_KEY, nextUsername);
  }catch(error){
    console.error('user index rename add error:', error);
  }
  if(previousUsername !== nextUsername){
    await redis.del(`${USER_KEY_PREFIX}${previousUsername}`);
    try{
      await redis.srem(USER_INDEX_KEY, previousUsername);
    }catch(error){
      console.error('user index rename remove error:', error);
    }
    const legacyUsers = await getUsers();
    if(legacyUsers[previousUsername]){
      delete legacyUsers[previousUsername];
      await setLegacyUsers(legacyUsers);
    }
  }
  return user;
}

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
  const articles = Array.isArray(input.articles)
    ? input.articles
        .filter(article => article && typeof article === 'object' && !Array.isArray(article))
        .slice(0, 100)
        .map(article => ({
          id: typeof article.id === 'string' ? article.id.slice(0, 80) : crypto.randomUUID(),
          title: typeof article.title === 'string' ? article.title.trim().slice(0, 120) : '未命名文章',
          category: typeof article.category === 'string' ? article.category.trim().slice(0, 40) : 'USER',
          summary: typeof article.summary === 'string' ? article.summary.trim().slice(0, 260) : '',
          content: typeof article.content === 'string' ? article.content.slice(0, 8_000_000) : '',
          thumb: typeof article.thumb === 'string' && article.thumb.startsWith('data:image/') && Buffer.byteLength(article.thumb, 'utf8') <= 3_800_000
            ? article.thumb
            : 'linear-gradient(135deg,#7c5cff,#ff8fc7)',
          fontFamily: typeof article.fontFamily === 'string' ? article.fontFamily.slice(0, 80) : '',
          createdAt: typeof article.createdAt === 'string' ? article.createdAt.slice(0, 40) : nowIso(),
          updatedAt: typeof article.updatedAt === 'string' ? article.updatedAt.slice(0, 40) : nowIso()
        }))
        .filter(article => article.title || article.content)
    : [];
  return {
    avatar: sanitizeAvatar(input.avatar),
    nickname: typeof input.nickname === 'string' ? input.nickname.trim().slice(0, 40) : username,
    signature: typeof input.signature === 'string' ? input.signature.trim().slice(0, 120) : '',
    intro: typeof input.intro === 'string' ? input.intro.trim().slice(0, 500) : '',
    tags,
    texts,
    files,
    articles
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
    ...(user.profile || {})
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
