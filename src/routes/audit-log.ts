import { Router } from 'express';
import { requireUser } from '../auth.js';
import { query } from '../db.js';
import { HttpError } from '../http.js';

export const auditLogRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function optDate(q: Record<string, unknown>, field: string): string | null {
  const v = q[field];
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new HttpError(400, `${field} ต้องเป็นรูปแบบ YYYY-MM-DD`);
  return v;
}

// ponytail: ไม่มีการลบข้อมูลเก่าออกเลย ตารางโตไปเรื่อย ๆ — สเกลครอบครัวโตช้ามาก (หลักหมื่นแถว/ปี)
// ถ้าวันไหนใหญ่จริงค่อยเพิ่ม `delete from audit_log where created_at < now() - interval '2 years'`
// เข้า worker เดือนละครั้ง ยังไม่ทำเป็น cron ตอนนี้เพราะจะกลายเป็นกลไกที่ต้องดูแลโดยไม่มีใครเดือดร้อน

/**
 * §7.6 ประวัติ audit — **default คือของตัวเองเท่านั้น** ไม่ว่าจะเป็นแอดมินหรือไม่
 * แอดมินต้องขอข้ามคนอื่นแบบชัดแจ้ง (`?scope=all` หรือ `?user_id=`) ถ้าให้แอดมินเห็นทุกคน
 * โดย default หน้า `/audit` ส่วนตัวของแอดมินจะกลายเป็นมุมมองรวมทุกคนแบบเงียบ ๆ ซึ่งไม่ใช่สิ่งที่ตั้งใจ
 */
auditLogRouter.get('/audit-log', requireUser(async (req, res, user) => {
  const q = req.query as Record<string, unknown>;
  const entityType = typeof q.entity_type === 'string' && q.entity_type !== '' ? q.entity_type : null;
  const action = typeof q.action === 'string' && q.action !== '' ? q.action : null;
  const from = optDate(q, 'from');
  const to = optDate(q, 'to');

  const scope = q.scope == null || q.scope === '' ? 'self' : q.scope;
  if (scope !== 'self' && scope !== 'all') throw new HttpError(400, "scope ต้องเป็น 'self' หรือ 'all'");
  const userIdRaw = q.user_id == null || q.user_id === '' ? null : Number(q.user_id);
  if (userIdRaw !== null && (!Number.isInteger(userIdRaw) || userIdRaw <= 0)) {
    throw new HttpError(400, 'user_id ไม่ถูกต้อง');
  }
  // ขออ่านของคนอื่น (ทั้งแบบรวมและระบุตัว) ต้องเป็นแอดมิน — คนทั่วไปได้ 403 ไม่ใช่ผลลัพธ์ว่าง
  const wantsOthers = scope === 'all' || (userIdRaw !== null && userIdRaw !== user.id);
  if (wantsOthers && !user.is_admin) throw new HttpError(403, 'ต้องเป็นแอดมิน');
  // user_id เจาะจงชนะ scope=all (เฉพาะเจาะจงกว่า) · null = ทุกคน
  const targetUserId = userIdRaw ?? (scope === 'all' ? null : user.id);

  const limitRaw = q.limit == null || q.limit === '' ? 50 : Number(q.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) throw new HttpError(400, 'limit ไม่ถูกต้อง');
  const offsetRaw = q.offset == null || q.offset === '' ? 0 : Number(q.offset);
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) throw new HttpError(400, 'offset ไม่ถูกต้อง');
  const limit = Math.min(limitRaw, 200);

  const params = [targetUserId, entityType, action, from, to];
  const filterSql = `
    from audit_log l join app_user u on u.id = l.user_id
    where ($1::bigint is null or l.user_id = $1)
      and ($2::text is null or l.entity_type = $2)
      and ($3::text is null or l.action = $3)
      and ($4::date is null or l.created_at >= $4::date)
      and ($5::date is null or l.created_at < ($5::date + interval '1 day'))`;

  const { rows } = await query(
    `select l.id, l.user_id, u.email as user_email, u.display_name as user_display_name,
            l.action, l.entity_type, l.entity_id, l.before_data, l.after_data, l.ip_address, l.created_at,
            count(*) over () as total_count
     ${filterSql}
     order by l.created_at desc, l.id desc
     limit $6 offset $7`,
    [...params, limit, offsetRaw],
  );
  const totalCount =
    rows.length > 0
      ? Number(rows[0]!.total_count)
      : ((await query<{ n: number }>(`select count(*)::int as n ${filterSql}`, params)).rows[0]?.n ?? 0);

  res.json({ rows: rows.map(({ total_count: _t, ...r }) => r), total_count: totalCount, limit, offset: offsetRaw });
}));
