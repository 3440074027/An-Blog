import { Redis } from '@upstash/redis';
import { json } from './_lib/auth.js';
import { DB_VISITOR_COUNT_KEY, LEGACY_VISITOR_COUNT_KEY } from './_lib/db-keys.js';

const redis = Redis.fromEnv();

export async function onRequestGet(){
  try{
    let value = Number(await redis.get(DB_VISITOR_COUNT_KEY) || 0);
    if(!value){
      const legacy = Number(await redis.get(LEGACY_VISITOR_COUNT_KEY) || 0);
      if(legacy){
        value = legacy;
        await redis.set(DB_VISITOR_COUNT_KEY, legacy);
      }
    }
    return json({ ok:true, value });
  }catch(error){
    console.error('visitor-count get error:', error);
    return json({ error:'访问量统计失败。' }, 500);
  }
}

export async function onRequestPost(){
  try{
    const value = await redis.incr(DB_VISITOR_COUNT_KEY);
    return json({ ok:true, value });
  }catch(error){
    console.error('visitor-count post error:', error);
    return json({ error:'访问量统计失败。' }, 500);
  }
}

export function onRequest(){
  return json({ error:'只支持 GET 或 POST 请求。' }, 405);
}
