import {
  json,
  readJsonBody,
  requireUser,
  isSiteOwner,
  getUser,
  setUser,
  deleteUser,
  hashPassword,
  sanitizeUserProfile,
  publicUser,
  nowIso,
  invalidateListUsersCache
} from './_lib/auth.js';

/* 角色等级 */
const ROLE_LEVEL = { '站主': 100, '作者': 50, '访客': 10 };

/* 管理权限检查：站主和作者可访问 */
async function requireAdmin(context){
  const auth = await requireUser(context.request);
  if(auth.error) return { response: json({ error: auth.error }, auth.status) };
  const user = auth.user;
  const owner = isSiteOwner(user);
  const tags = user.profile?.tags || [];
  const isAdmin = owner || tags.includes('作者');
  if(!isAdmin) return { response: json({ error: '权限不足，仅站主和作者可执行此操作。' }, 403) };
  return { user, isOwner: owner };
}

/* 检查目标用户是否存在 */
async function requireTargetUser(username){
  if(!username) return { response: json({ error: '缺少目标用户名。' }, 400) };
  const target = await getUser(username);
  if(!target) return { response: json({ error: '目标用户不存在。' }, 404) };
  return { target };
}

/* 权限保护：不能修改同级或更高级的用户 */
function checkPermission(admin, target){
  if(!admin.isOwner && isSiteOwner(target)){
    return '权限不足，无法修改站主信息。';
  }
  if(!admin.isOwner){
    const adminTags = admin.user.profile?.tags || [];
    const adminRole = adminTags.includes('作者') ? '作者' : '访客';
    const adminLevel = ROLE_LEVEL[adminRole] || 0;
    const targetTags = target.profile?.tags || [];
    const targetRole = isSiteOwner(target) ? '站主' : (targetTags.includes('作者') ? '作者' : '访客');
    const targetLevel = ROLE_LEVEL[targetRole] || 0;
    if(adminLevel <= targetLevel){
      return '权限不足，无法修改同级或更高级用户。';
    }
  }
  return null;
}

/* POST /api/admin — 管理操作入口 */
export async function onRequestPost(context){
  const admin = await requireAdmin(context);
  if(admin.response) return admin.response;

  try{
    const body = await readJsonBody(context.request);
    const action = String(body.action || '').trim();
    const targetUsername = String(body.username || '').trim();

    const targetResult = await requireTargetUser(targetUsername);
    if(targetResult.response) return targetResult.response;
    const target = targetResult.target;

    switch(action){
      case 'edit': {
        const protection = checkPermission(admin, target);
        if(protection) return json({ error: protection }, 403);

        const newNickname = body.nickname !== undefined ? String(body.nickname || '').slice(0, 40) : undefined;
        const newRole = body.role !== undefined ? String(body.role || '') : undefined;

        if(newNickname !== undefined && target.profile){
          target.profile.nickname = newNickname;
        }
        if(newRole !== undefined && target.profile){
          // 更新 tags 中的角色标签（只保留站主/作者/访客）
          const tags = target.profile.tags || [];
          const roleTags = ['作者', '访客'];
          target.profile.tags = tags.filter(t => !roleTags.includes(t));
          // 访客不添加标签
          if(newRole && newRole !== '访客' && roleTags.includes(newRole)){
            target.profile.tags.push(newRole);
          }
        }
        target.updatedAt = nowIso();
        await setUser(target);
        return json({ ok: true, user: publicUser(target) });
      }

      case 'reset-password': {
        const protection = checkPermission(admin, target);
        if(protection) return json({ error: protection }, 403);

        const newPassword = String(body.newPassword || '1234567890');
        target.password = hashPassword(newPassword);
        target.updatedAt = nowIso();
        await setUser(target);
        return json({ ok: true, message: `已重置 ${targetUsername} 的密码。` });
      }

      case 'disable': {
        const protection = checkPermission(admin, target);
        if(protection) return json({ error: protection }, 403);

        if(!target.profile) target.profile = {};
        const tags = target.profile.tags || [];
        if(!tags.includes('disabled')){
          tags.push('disabled');
          target.profile.tags = tags;
        }
        target.updatedAt = nowIso();
        await setUser(target);
        return json({ ok: true, message: `已禁用用户 ${targetUsername}。` });
      }

      case 'enable': {
        const protection = checkPermission(admin, target);
        if(protection) return json({ error: protection }, 403);

        if(target.profile){
          target.profile.tags = (target.profile.tags || []).filter(t => t !== 'disabled');
        }
        target.updatedAt = nowIso();
        await setUser(target);
        return json({ ok: true, message: `已启用用户 ${targetUsername}。` });
      }

      case 'delete': {
        if(!admin.isOwner) return json({ error: '仅站主可删除账号。' }, 403);
        if(isSiteOwner(target)) return json({ error: '不能删除站主账号。' }, 403);

        await deleteUser(targetUsername);
        return json({ ok: true, deleted: true, message: `已删除用户 ${targetUsername}。` });
      }

      default:
        return json({ error: `未知操作: ${action}` }, 400);
    }
  }catch(error){
    console.error('admin action error:', error);
    return json({ error: '管理操作失败，请稍后再试。' }, 500);
  }
}

export function onRequest(){
  return json({ error: '只支持 POST 请求。' }, 405);
}
