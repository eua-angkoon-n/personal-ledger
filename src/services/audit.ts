// รับแค่ความสามารถที่ audit() ใช้จริง — `Pool`/`PoolClient` เข้าได้อยู่แล้ว และ auth.ts ที่ถือ
// `query` เป็นฟังก์ชันฉีดเข้ามา (createAuthRouter) ก็ห่อเป็น `{ query }` ส่งเข้าตรงนี้ได้เลย
type Queryable = { query(text: string, params?: unknown[]): Promise<unknown> };

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
