import type { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export type AuditEvent = {
  userId: number;
  action: string;
  entityType: string;
  entityId?: number;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

/** เขียนผ่าน client เดียวกับ transaction ที่กำลังทำ ให้ audit กับการแก้ข้อมูล commit/rollback พร้อมกันเสมอ (§7.6) */
export async function audit(c: Queryable, e: AuditEvent): Promise<void> {
  await c.query(
    `insert into audit_log (user_id, action, entity_type, entity_id, before_data, after_data, ip_address)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.userId,
      e.action,
      e.entityType,
      e.entityId ?? null,
      e.before !== undefined ? JSON.stringify(e.before) : null,
      e.after !== undefined ? JSON.stringify(e.after) : null,
      e.ip ?? null,
    ],
  );
}
