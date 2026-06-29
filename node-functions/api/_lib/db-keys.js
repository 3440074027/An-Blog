/*
 * 数据库总览（Upstash Redis）
 * --------------------------------------------------
 * 全站采用集中式 HASH 存储结构，便于查看与维护：
 *
 *  db:users           HASH    用户全表：field=username, value=user JSON（含 password、profile）
 *  db:friends         HASH    好友/请求全表：field=username,
 *                              value={ friends:[u,...], incoming:[{from,message,createdAt}],
 *                                      outgoing:[{to,message,createdAt}], updatedAt }
 *  db:chats           HASH    聊天会话全表：field=conversationId(双方用户名按字典序排序后用 "::" 连接),
 *                              value={ a, b, messages:[{id,from,to,body,attachments,createdAt}],
 *                                      reads:{ <username>:lastReadMessageId }, updatedAt }
 *  db:articles        HASH    文章全表：field=articleId, value=article JSON（含正文与作者）
 *  db:announcements   STRING  公告：JSON 数组（站主统一编辑）
 *  db:visitor-count   STRING  访问量计数器
 *  db:article-likes      HASH    文章点赞：field=articleId, value={ username:isoTimestamp, ... }
 *  db:article-favorites  HASH    文章收藏：field=articleId, value={ username:isoTimestamp, ... }
 *
 * 历史遗留键（仅在新键缺失时读取并自动迁移到上面的集中表，新代码不再写入）：
 *   user:<username>          / site:user-index / users
 *   site:announcements
 *   site:article-index:v2    / site:article:<id> / site:articles
 *   mail:box:<u>             / mail:inbox:<u> / mail:sent:<u>      （邮件功能已废弃，仅做迁移清理）
 *   db:mails                                                       （邮件功能已废弃，仅做迁移清理）
 *   site:visitor-count
 */

// 集中数据表
export const DB_USERS_HASH = 'db:users';
export const DB_FRIENDS_HASH = 'db:friends';
export const DB_CHATS_HASH = 'db:chats';
export const DB_ARTICLES_HASH = 'db:articles';
export const DB_ANNOUNCEMENTS_KEY = 'db:announcements';

export const DB_VISITOR_COUNT_KEY = 'db:visitor-count';

// 文章互动数据
export const DB_ARTICLE_LIKES_HASH = 'db:article-likes';    // field=articleId, value={ username:isoTimestamp, ... }
export const DB_ARTICLE_FAVORITES_HASH = 'db:article-favorites'; // field=articleId, value={ username:isoTimestamp, ... }

// 用户点赞/收藏计数器（O(1) 读取，toggleReaction 时同步增减）
export const userLikeCountKey = username => `db:user-likes:${username}`;
export const userFavCountKey  = username => `db:user-favs:${username}`;

// 邮件相关键（旧版数据，清理用）
export const LEGACY_DB_MAILS_HASH = 'db:mails';
// 兼容老代码引用（已废弃，等价于 LEGACY_DB_MAILS_HASH）
export const DB_MAILS_HASH = LEGACY_DB_MAILS_HASH;

// 会话 ID（用户名按字典序拼接，保证 a→b 与 b→a 是同一个会话）
export function conversationIdOf(a, b){
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if(!x || !y) return '';
  return [x, y].sort().join('::');
}

// ----- 历史遗留键（只读迁移用） -----
export const LEGACY_USER_KEY_PREFIX = 'user:';
export const LEGACY_USER_INDEX_KEY = 'site:user-index';
export const LEGACY_USER_STORE_KEY = 'users';
export const legacyUserKey = username => `${LEGACY_USER_KEY_PREFIX}${username}`;

export const LEGACY_ANNOUNCEMENTS_KEY = 'site:announcements';

export const LEGACY_ARTICLE_INDEX_KEY = 'site:article-index:v2';
export const LEGACY_ARTICLE_KEY_PREFIX = 'site:article:';
export const LEGACY_ARTICLES_KEY = 'site:articles';
export const legacyArticleKey = id => `${LEGACY_ARTICLE_KEY_PREFIX}${id}`;

export const LEGACY_MAILBOX_KEY_PREFIX = 'mail:box:';
export const LEGACY_INBOX_KEY_PREFIX = 'mail:inbox:';
export const LEGACY_SENT_KEY_PREFIX = 'mail:sent:';
export const legacyMailboxKey = username => `${LEGACY_MAILBOX_KEY_PREFIX}${username}`;
export const legacyInboxKey = username => `${LEGACY_INBOX_KEY_PREFIX}${username}`;
export const legacySentKey = username => `${LEGACY_SENT_KEY_PREFIX}${username}`;

export const LEGACY_VISITOR_COUNT_KEY = 'site:visitor-count';
