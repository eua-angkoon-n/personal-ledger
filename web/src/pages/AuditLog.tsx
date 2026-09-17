import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box, Collapse, IconButton, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import KeyboardArrowRightRounded from '@mui/icons-material/KeyboardArrowRightRounded';
import { req, type AuditLogEntry, type AuditLogListResponse } from '../api.js';
import { formatDateTime } from '../format.js';
import { dataTextSx, descriptionSx } from '../theme.js';
import { EmptyState, LoadError, PageHeader, TableSkeleton } from '../ui.js';

const LIMIT = 50;

/** JSON ของ before/after แสดงดิบ — เป็นข้อมูลเทคนิค ใช้ฟอนต์ data ตาม Financial Clarity Rule */
function DetailBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <Box sx={{ minWidth: 0, flex: 1 }}>
      <Typography component="h4" color="text.secondary" sx={{ fontSize: '0.875rem', fontWeight: 650 }}>{label}</Typography>
      <Box
        component="pre"
        sx={{ ...dataTextSx, m: 0, mt: 0.5, p: 1.5, fontSize: '0.875rem', borderRadius: 1, border: 1, borderColor: 'divider', bgcolor: 'background.default', overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
      >
        {JSON.stringify(value, null, 2)}
      </Box>
    </Box>
  );
}

function LogRow({ entry, showUser }: { entry: AuditLogEntry; showUser: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.before_data != null || entry.after_data != null || entry.ip_address != null;
  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 48, pr: 0 }}>
          {hasDetail && (
            <IconButton
              size="small"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? 'ซ่อนรายละเอียด' : 'ดูรายละเอียด'}
            >
              {open ? <KeyboardArrowDownRounded /> : <KeyboardArrowRightRounded />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={dataTextSx}>{formatDateTime(entry.created_at)}</TableCell>
        {showUser && (
          <TableCell sx={dataTextSx}>{entry.user_display_name || entry.user_email}</TableCell>
        )}
        <TableCell sx={dataTextSx}>{entry.action}</TableCell>
        <TableCell>{entry.entity_type}</TableCell>
        <TableCell sx={dataTextSx}>{entry.entity_id ?? <Typography component="span" color="text.secondary">—</Typography>}</TableCell>
      </TableRow>
      {hasDetail && (
        <TableRow>
          <TableCell colSpan={showUser ? 6 : 5} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} unmountOnExit>
              <Stack spacing={2} sx={{ py: 2 }}>
                <Typography sx={{ ...dataTextSx, fontSize: '0.875rem' }} color="text.secondary">
                  IP: {entry.ip_address ?? '—'}
                  {showUser && ` · ${entry.user_email}`}
                </Typography>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                  <DetailBlock label="ค่าเดิม (before)" value={entry.before_data} />
                  <DetailBlock label="ค่าใหม่ (after)" value={entry.after_data} />
                </Stack>
              </Stack>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type Props = {
  /**
   * `self` = หน้า `/audit` ของผู้ใช้ (default) · `admin` = แท็บในหน้าตั้งค่า ส่ง `scope=all` ข้ามผู้ใช้
   * ต้องขอข้ามผู้ใช้แบบชัดแจ้งเสมอ (ดู comment ใน `src/routes/audit-log.ts`) หน้านี้จึงไม่เดาจาก is_admin เอง
   */
  variant?: 'self' | 'admin';
};

// §7.6 — หน้าอ่านอย่างเดียว ไม่มีการแก้ไข
export default function AuditLog({ variant = 'self' }: Props) {
  const isAdmin = variant === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType = searchParams.get('entity_type') ?? '';
  const action = searchParams.get('action') ?? '';
  const userId = searchParams.get('user_id') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

  const [data, setData] = useState<AuditLogListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const setFilter = (patch: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === '') next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in patch)) next.delete('page');
      return next;
    });
  };

  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    const p = new URLSearchParams();
    if (entityType) p.set('entity_type', entityType);
    if (action) p.set('action', action);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (isAdmin) {
      // user_id เจาะจงชนะ scope=all ที่ฝั่ง route อยู่แล้ว ส่งทั้งคู่ได้ไม่ขัดกัน
      p.set('scope', 'all');
      if (userId) p.set('user_id', userId);
    }
    p.set('limit', String(LIMIT));
    p.set('offset', String((page - 1) * LIMIT));
    req<AuditLogListResponse>(`/api/audit-log?${p.toString()}`)
      .then((result) => { if (current) setData(result); })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [entityType, action, userId, from, to, page, isAdmin]);

  const rows = data?.rows ?? [];

  return (
    <Box>
      <PageHeader
        level={isAdmin ? 2 : 1}
        id={isAdmin ? 'admin-audit-log-heading' : 'audit-log-heading'}
        title={isAdmin ? 'บันทึกระบบ (แอดมิน)' : 'ประวัติการเปลี่ยนแปลง'}
        description={isAdmin
          ? 'ทุกการกระทำของผู้ใช้ทุกคน — เข้า/ออกระบบ, แก้ข้อมูล, อัปโหลด/ดาวน์โหลดเอกสาร, อนุมัติผู้ใช้ กดลูกศรเพื่อดูค่าก่อน-หลังและ IP'
          : 'บันทึกทุกครั้งที่มีการเข้าสู่ระบบและเปลี่ยนแปลงข้อมูลของคุณ กดลูกศรหน้าแถวเพื่อดูค่าก่อน-หลัง (§7.6)'}
      />

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: isAdmin ? 2 : 3, mb: 2 }} data-tour="audit-filters">
        <TextField size="small" label="ประเภทข้อมูล (entity_type)" value={entityType} onChange={(e) => setFilter({ entity_type: e.target.value })} sx={{ minWidth: 200 }} />
        <TextField size="small" label="การกระทำ (action)" value={action} onChange={(e) => setFilter({ action: e.target.value })} sx={{ minWidth: 200 }} />
        {isAdmin && (
          <TextField size="small" label="รหัสผู้ใช้ (user_id)" value={userId} onChange={(e) => setFilter({ user_id: e.target.value })} sx={{ minWidth: 150 }} />
        )}
        <TextField size="small" type="date" label="ตั้งแต่วันที่" value={from} onChange={(e) => setFilter({ from: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ minWidth: 160 }} />
        <TextField size="small" type="date" label="ถึงวันที่" value={to} onChange={(e) => setFilter({ to: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} sx={{ minWidth: 160 }} />
      </Box>

      {error && <LoadError message={error} onRetry={() => setFilter({})} />}
      {loading ? <TableSkeleton rows={8} /> : error ? null : rows.length === 0 ? (
        <EmptyState title="ไม่พบประวัติในเงื่อนไขนี้" description="ลองล้างตัวกรอง หรือประวัติยังไม่เกิดขึ้น" icon={null} />
      ) : (
        <>
          <TableContainer component={Paper} variant="outlined" tabIndex={0}>
            <Table size="small" sx={{ minWidth: 720 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 48 }} aria-label="ขยายรายละเอียด" />
                  <TableCell>เวลา</TableCell>
                  {isAdmin && <TableCell>ผู้ใช้</TableCell>}
                  <TableCell>การกระทำ</TableCell>
                  <TableCell>ประเภทข้อมูล</TableCell>
                  <TableCell>รหัสข้อมูล</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => <LogRow key={r.id} entry={r} showUser={isAdmin} />)}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={data?.total_count ?? 0}
            page={page - 1}
            onPageChange={(_, newPage) => setFilter({ page: String(newPage + 1) })}
            rowsPerPage={LIMIT}
            rowsPerPageOptions={[LIMIT]}
            labelDisplayedRows={({ from: f, to: t, count }) => `${f}–${t} จาก ${count}`}
            sx={dataTextSx}
          />
          {isAdmin && (
            <Typography color="text.secondary" sx={{ mt: 1, ...descriptionSx, fontSize: '0.875rem' }}>
              ความพยายามเข้าระบบที่ล้มเหลว (state ไม่ตรง, ยิงถี่เกินเพดาน) ไม่ได้เก็บในตารางนี้ — ดูที่ `docker compose logs app`
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}
