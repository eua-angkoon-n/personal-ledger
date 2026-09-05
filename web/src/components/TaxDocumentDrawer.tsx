import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import { patch, put, req, type TaxDocumentDetail, type TaxEntity, type TxnListResponse } from '../api.js';
import { currentMonth } from './MonthPicker.js';
import { formatDate } from '../format.js';
import { dataTextSx } from '../theme.js';
import { DOCUMENT_TYPE_LABEL } from '../taxDocumentLabels.js';
import { LoadError, type Notice } from '../ui.js';
import Money from './Money.js';
import TaxDocumentStatusChip from './TaxDocumentStatusChip.js';

type LinkRow = { txn_id: number; linked_amount_satang: number; txn_date: string; description: string };

function detailToLinkRows(detail: TaxDocumentDetail): LinkRow[] {
  return detail.links.map((l) => ({
    txn_id: l.txn_id, linked_amount_satang: l.linked_amount_satang, txn_date: l.txn_date, description: l.description,
  }));
}

type Props = {
  docId: number | null;
  taxEntities: TaxEntity[];
  onClose: () => void;
  onSaved: () => void;
  onNotice: (notice: Notice) => void;
};

// โครงเดียวกับ ReviewDrawer.tsx — รับ id ไม่ใช่ object, fetch เอง, section คั่นด้วย Divider
export default function TaxDocumentDrawer({ docId, taxEntities, onClose, onSaved, onNotice }: Props) {
  const [detail, setDetail] = useState<TaxDocumentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [savingLinks, setSavingLinks] = useState(false);
  const [searchMonth, setSearchMonth] = useState(currentMonth());
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TxnListResponse['rows']>([]);
  const [searching, setSearching] = useState(false);
  const requestIdRef = useRef(0);

  const load = async (id: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const d = await req<TaxDocumentDetail>(`/api/tax-documents/${id}`);
      if (requestId !== requestIdRef.current) return;
      setDetail(d);
      setLinks(detailToLinkRows(d));
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'โหลดรายละเอียดไม่สำเร็จ');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (docId != null) void load(docId);
    else { setDetail(null); setSearchResults([]); setSearchQuery(''); }
  }, [docId]);

  const taxEntityName = taxEntities.find((e) => e.id === detail?.tax_entity_id)?.display_name ?? '—';

  const markVerified = async () => {
    if (!detail) return;
    setVerifying(true);
    try {
      const updated = await patch<{ status: TaxDocumentDetail['status']; verified_at: string | null }>(
        `/api/tax-documents/${detail.id}`,
        { status: 'verified' },
      );
      setDetail((d) => (d ? { ...d, status: updated.status, verified_at: updated.verified_at } : d));
      onNotice({ message: 'ตรวจสอบเอกสารแล้ว', severity: 'success' });
      onSaved();
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'ตั้งสถานะไม่สำเร็จ', severity: 'error' });
    } finally {
      setVerifying(false);
    }
  };

  const runSearch = async () => {
    setSearching(true);
    try {
      const q = new URLSearchParams({ month: searchMonth, limit: '10' });
      if (searchQuery.trim()) q.set('q', searchQuery.trim());
      const result = await req<TxnListResponse>(`/api/transactions?${q}`);
      setSearchResults(result.rows);
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'ค้นหาธุรกรรมไม่สำเร็จ', severity: 'error' });
    } finally {
      setSearching(false);
    }
  };

  const addLink = (row: TxnListResponse['rows'][number]) => {
    if (links.some((l) => l.txn_id === row.id)) return;
    setLinks((rows) => [...rows, { txn_id: row.id, linked_amount_satang: row.amount_satang, txn_date: row.txn_date, description: row.description }]);
  };

  const saveLinks = async () => {
    if (!detail) return;
    setSavingLinks(true);
    try {
      await put(`/api/tax-documents/${detail.id}/links`, links.map((l) => ({ txn_id: l.txn_id, linked_amount_satang: l.linked_amount_satang })));
      onNotice({ message: 'บันทึกการเชื่อมธุรกรรมแล้ว', severity: 'success' });
      await load(detail.id);
      onSaved();
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'บันทึกการเชื่อมไม่สำเร็จ', severity: 'error' });
    } finally {
      setSavingLinks(false);
    }
  };

  return (
    <Drawer anchor="right" open={docId != null} onClose={onClose} slotProps={{ paper: { 'aria-labelledby': 'tax-doc-drawer-heading' } }}>
      <Box sx={{ width: { xs: '100vw', sm: 460 }, p: 3, height: '100%', overflowY: 'auto' }}>
        <Stack direction="row" sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h2" id="tax-doc-drawer-heading" sx={{ fontSize: '1.25rem' }}>รายละเอียดเอกสารภาษี</Typography>
          <IconButton aria-label="ปิด" onClick={onClose}><CloseRounded /></IconButton>
        </Stack>

        {error && <LoadError message={error} onRetry={docId != null ? () => void load(docId) : undefined} />}

        {loading ? (
          <Stack spacing={2}>
            <Skeleton variant="rounded" height={100} />
            <Skeleton variant="rounded" height={140} />
          </Stack>
        ) : detail && !error ? (
          <Stack spacing={3}>
            <Box>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 650 }}>{detail.issuer_name}</Typography>
                <TaxDocumentStatusChip status={detail.status} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={dataTextSx}>
                {DOCUMENT_TYPE_LABEL[detail.document_type]} · ปีภาษี {detail.tax_year} · {taxEntityName}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, ...dataTextSx }}>
                {detail.original_filename}{detail.issue_date ? ` · ${formatDate(detail.issue_date)}` : ''}
              </Typography>
              <Money satang={detail.total_satang} sx={{ fontSize: '1.75rem', display: 'block', mt: 1 }} />
              <Button
                component="a"
                href={`/api/tax-documents/${detail.id}/file`}
                download
                variant="outlined"
                size="small"
                startIcon={<DownloadRounded />}
                sx={{ mt: 1.5 }}
              >
                ดาวน์โหลดไฟล์ต้นฉบับ
              </Button>
            </Box>

            <Divider />

            <Box component="section" aria-labelledby="tax-doc-status-heading">
              <Typography variant="h2" id="tax-doc-status-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>สถานะตรวจสอบ</Typography>
              {detail.status === 'draft' ? (
                <Button variant="contained" onClick={() => void markVerified()} disabled={verifying} aria-busy={verifying}>
                  {verifying ? 'กำลังบันทึก…' : 'ทำเครื่องหมายว่าตรวจสอบแล้ว'}
                </Button>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  ตรวจสอบแล้วเมื่อ {detail.verified_at ? formatDate(detail.verified_at) : '—'}
                </Typography>
              )}
            </Box>

            <Divider />

            <Box component="section" aria-labelledby="tax-doc-links-heading">
              <Typography variant="h2" id="tax-doc-links-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>เชื่อมกับธุรกรรม</Typography>

              {links.length === 0 ? (
                <Typography variant="body2" color="text.secondary">ยังไม่ได้เชื่อมกับธุรกรรมใด</Typography>
              ) : (
                <Stack spacing={1} sx={{ mb: 1.5 }}>
                  {links.map((l) => (
                    <Stack key={l.txn_id} direction="row" spacing={1} sx={{ alignItems: 'center', p: 1, border: 1, borderColor: 'divider', borderRadius: '10px' }}>
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography variant="body2" noWrap>{l.description}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={dataTextSx}>{formatDate(l.txn_date)}</Typography>
                      </Box>
                      <Money satang={l.linked_amount_satang} sx={{ fontSize: '0.875rem' }} />
                      <IconButton
                        aria-label="เอาออกจากการเชื่อม"
                        size="small"
                        onClick={() => setLinks((rows) => rows.filter((r) => r.txn_id !== l.txn_id))}
                      >
                        <DeleteOutlineRounded fontSize="small" />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
              )}

              <Button variant="outlined" size="small" onClick={() => void saveLinks()} disabled={savingLinks} aria-busy={savingLinks} sx={{ mb: 2 }}>
                {savingLinks ? 'กำลังบันทึก…' : 'บันทึกการเชื่อม'}
              </Button>

              <Typography variant="body2" sx={{ fontWeight: 650, mb: 1 }}>ค้นหาธุรกรรมเพื่อเพิ่ม</Typography>
              <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
                <TextField
                  type="month"
                  size="small"
                  value={searchMonth}
                  onChange={(e) => e.target.value && setSearchMonth(e.target.value)}
                  slotProps={{ htmlInput: { sx: dataTextSx } }}
                />
                <TextField
                  size="small"
                  label="ค้นหา"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
                  sx={{ flexGrow: 1 }}
                />
                <Button variant="outlined" size="small" onClick={() => void runSearch()} disabled={searching} aria-busy={searching}>ค้นหา</Button>
              </Stack>
              {searchResults.length > 0 && (
                <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: '10px', maxHeight: 240, overflowY: 'auto' }}>
                  {searchResults.map((row) => (
                    <ListItemButton key={row.id} onClick={() => addLink(row)} disabled={links.some((l) => l.txn_id === row.id)}>
                      <ListItemText
                        primary={row.description}
                        secondary={`${formatDate(row.txn_date)} · ${row.direction === 'credit' ? '+' : '-'}฿${(row.amount_satang / 100).toFixed(2)}`}
                      />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </Box>
          </Stack>
        ) : null}
      </Box>
    </Drawer>
  );
}
