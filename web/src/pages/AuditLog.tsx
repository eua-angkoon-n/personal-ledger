import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box, Paper, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import { req, type AuditLogListResponse } from '../api.js';
import { formatDateTime } from '../format.js';
import { dataTextSx } from '../theme.js';
import { EmptyState, LoadError, PageHeader, TableSkeleton } from '../ui.js';

const LIMIT = 50;

// §7.6 — หน้าอ่านอย่างเดียว ไม่มีการแก้ไข ดูประวัติการกระทำสำคัญทั้งหมดของตัวเอง
export default function AuditLog() {
  const [searchParams, setSearchParams] = useSearchParams();
  const entityType = searchParams.get('entity_type') ?? '';
  const action = searchParams.get('action') ?? '';
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
    p.set('limit', String(LIMIT));
    p.set('offset', String((page - 1) * LIMIT));
    req<AuditLogListResponse>(`/api/audit-log?${p.toString()}`)
      .then((result) => { if (current) setData(result); })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [entityType, action, page]);

  const rows = data?.rows ?? [];

  return (
    <Box>
      <PageHeader
        level={1}
        id="audit-log-heading"
        title="ประวัติการเปลี่ยนแปลง"
        description="บันทึกทุกครั้งที่มีการเปลี่ยน Tax Treatment, ยืนยัน/ยกเลิกคู่โอน, mark paid, แก้แผน/ค่าลดหย่อน, archive บัญชี และดาวน์โหลดเอกสารภาษี (§7.6)"
      />

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mt: 3, mb: 2 }}>
        <TextField size="small" label="ประเภทข้อมูล (entity_type)" value={entityType} onChange={(e) => setFilter({ entity_type: e.target.value })} sx={{ minWidth: 200 }} />
        <TextField size="small" label="การกระทำ (action)" value={action} onChange={(e) => setFilter({ action: e.target.value })} sx={{ minWidth: 200 }} />
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
                  <TableCell>เวลา</TableCell>
                  <TableCell>การกระทำ</TableCell>
                  <TableCell>ประเภทข้อมูล</TableCell>
                  <TableCell>รหัสข้อมูล</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={dataTextSx}>{formatDateTime(r.created_at)}</TableCell>
                    <TableCell sx={dataTextSx}>{r.action}</TableCell>
                    <TableCell>{r.entity_type}</TableCell>
                    <TableCell sx={dataTextSx}>{r.entity_id ?? <Typography component="span" color="text.secondary">—</Typography>}</TableCell>
                  </TableRow>
                ))}
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
            labelDisplayedRows={({ from, to, count }) => `${from}–${to} จาก ${count}`}
            sx={dataTextSx}
          />
        </>
      )}
    </Box>
  );
}
