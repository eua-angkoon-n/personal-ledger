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

// §7.6: อ่านประวัติ audit ของตัวเองเท่านั้น (user_id = $1 เสมอ ไม่มีมุมมอง admin ข้าม user ในเฟสนี้)
auditLogRouter.get('/audit-log', requireUser(async (req, res, user) => {
  const q = req.query as Record<string, unknown>;
  const entityType = typeof q.entity_type === 'string' && q.entity_type !== '' ? q.entity_type : null;
  const action = typeof q.action === 'string' && q.action !== '' ? q.action : null;
  const from = optDate(q, 'from');
  const to = optDate(q, 'to');

  const limitRaw = q.limit == null || q.limit === '' ? 50 : Number(q.limit);
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) throw new HttpError(400, 'limit ไม่ถูกต้อง');
  const offsetRaw = q.offset == null || q.offset === '' ? 0 : Number(q.offset);
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) throw new HttpError(400, 'offset ไม่ถูกต้อง');
  const limit = Math.min(limitRaw, 200);

  const params = [user.id, entityType, action, from, to];
  const filterSql = `
    where user_id = $1
      and ($2::text is null or entity_type = $2)
      and ($3::text is null or action = $3)
      and ($4::date is null or created_at >= $4::date)
      and ($5::date is null or created_at < ($5::date + interval '1 day'))`;

  const { rows } = await query(
    `select id, action, entity_type, entity_id, before_data, after_data, ip_address, created_at,
            count(*) over () as total_count
     from audit_log ${filterSql}
     order by created_at desc
     limit $6 offset $7`,
    [...params, limit, offsetRaw],
  );
  const totalCount =
    rows.length > 0
      ? Number(rows[0]!.total_count)
      : ((await query<{ n: number }>(`select count(*)::int as n from audit_log ${filterSql}`, params)).rows[0]?.n ?? 0);

  res.json({ rows: rows.map(({ total_count: _t, ...r }) => r), total_count: totalCount, limit, offset: offsetRaw });
}));
