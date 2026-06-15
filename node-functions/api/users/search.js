import { json, getRequestUrl, getUser, listUsers, publicUser } from '../_lib/auth.js';

function normalizeText(value){
  return String(value || '').trim().toLowerCase();
}

function publicSearchUser(user){
  const safeUser = publicUser(user);
  return {
    username: safeUser.username,
    createdAt: safeUser.createdAt,
    updatedAt: safeUser.updatedAt,
    profile: safeUser.profile
  };
}

export async function onRequestGet(context){
  try{
    const url = getRequestUrl(context.request);
    const rawQuery = String(url.searchParams.get('q') || '').trim();
    const query = normalizeText(rawQuery);
    const foundUsers = new Map();

    if(rawQuery){
      const directUser = await getUser(rawQuery);
      if(directUser && directUser.username){
        foundUsers.set(directUser.username, directUser);
      }
    }

    const users = await listUsers();
    users.forEach(user=>{
      if(user && user.username && !foundUsers.has(user.username)){
        foundUsers.set(user.username, user);
      }
    });

    const results = Array.from(foundUsers.values())
      .map(publicSearchUser)
      .filter(user=>{
        if(!query) return true;
        const profile = user.profile || {};
        const texts = profile.texts || {};
        const haystack = [
          user.username,
          profile.nickname,
          profile.signature,
          profile.intro,
          ...(Array.isArray(profile.tags) ? profile.tags : []),
          ...Object.values(texts)
        ].map(normalizeText).join(' ');
        return haystack.includes(query);
      })
      .slice(0, 30);
    return json({ ok:true, users:results });
  }catch(error){
    console.error('users search error:', error);
    return json({ error:'搜索用户失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 请求。' }, 405);
}
