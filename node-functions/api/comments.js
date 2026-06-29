// 评论功能已移除
export default function handler(req, res) {
  res.statusCode = 404;
  res.end(JSON.stringify({ ok: false, error: '评论功能已移除' }));
}
