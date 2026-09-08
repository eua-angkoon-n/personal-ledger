import { Router } from 'express';
import { requireUser } from '../auth.js';
import { query, tx } from '../db.js';
import { HttpError, str, type Body } from '../http.js';
import { audit } from '../services/audit.js';

export const categoriesRouter = Router();

const KINDS = ['income', 'expense'] as const;

// หมวดระบบ (user_id is null) รวมกับหมวดของ user เอง — is_active กรองได้ผ่าน query param แต่ default คืนทั้งหมด
categoriesRouter.get('/categories', requireUser(async (req, res, user) => {
  const isActive = req.query.is_active === 'true' ? true : req.query.is_active === 'false' ? false : null;
  const { rows } = await query(
    `select * from category
     where (user_id is null or user_id = $1)
       and ($2::boolean is null or is_active = $2)
     order by kind, name`,
    [user.id, isActive],
  );
  res.json(rows);
}));

categoriesRouter.post('/categories', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const name = str(b, 'name', 100);
  const kind = str(b, 'kind');
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new HttpError(400, `kind ต้องเป็นหนึ่งใน ${KINDS.join(', ')}`);
  }
  // ตาราง category ไม่มีคอลัมน์ความลับ — `returning *` เข้า audit ได้ตรง ๆ
  const created = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      `insert into category (user_id, name, kind, is_system) values ($1, $2, $3, false) returning *`,
      [user.id, name, kind],
    );
    await audit(c, { userId: user.id, action: 'category.create', entityType: 'category', entityId: rows[0]!.id, after: rows[0], ip: req.ip ?? null });
    return rows[0]!;
  });
  res.status(201).json(created);
}));

// ห้ามลบหมวดที่ถูกใช้งาน — มีแค่ PATCH is_active ไม่มี DELETE endpoint
// where user_id = $2 กันแก้หมวดระบบไปในตัวอยู่แล้ว (หมวดระบบ user_id เป็น null เสมอ)
categoriesRouter.patch('/categories/:id', requireUser(async (req, res, user) => {
  const b = req.body as Body;
  const categoryId = Number(req.params.id);
  const updated = await tx(async (c) => {
    const before = (await c.query('select * from category where id = $1 and user_id = $2', [categoryId, user.id])).rows[0];
    const { rows } = await c.query(
      `update category set
         name = coalesce($3, name),
         is_active = coalesce($4, is_active)
       where id = $1 and user_id = $2
       returning *`,
      [
        categoryId,
        user.id,
        b.name == null ? null : str(b, 'name', 100),
        typeof b.is_active === 'boolean' ? b.is_active : null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'ไม่พบหมวด');
    await audit(c, { userId: user.id, action: 'category.update', entityType: 'category', entityId: categoryId, before, after: rows[0], ip: req.ip ?? null });
    return rows[0];
  });
  res.json(updated);
}));
