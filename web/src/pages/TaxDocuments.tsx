import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Button,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import MarkEmailReadRounded from '@mui/icons-material/MarkEmailReadRounded';
import ReceiptRounded from '@mui/icons-material/ReceiptRounded';
import {
  del, req,
  type EmailAccount, type TaxDocumentListResponse, type TaxDocumentStatus, type TaxDocumentType, type TaxEntity,
} from '../api.js';
import GmailAttachmentPicker from '../components/GmailAttachmentPicker.js';
import TaxDocumentDrawer from '../components/TaxDocumentDrawer.js';
import TaxDocumentStatusChip from '../components/TaxDocumentStatusChip.js';
import TaxDocumentUploadModal from '../components/TaxDocumentUploadModal.js';
import { formatDate } from '../format.js';
import { DOCUMENT_TYPE_LABEL } from '../taxDocumentLabels.js';
import { dataTextSx } from '../theme.js';
import { ConfirmDialog, EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from '../ui.js';
import Money from '../components/Money.js';

const LIMIT = 50;

export default function TaxDocuments() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [taxEntities, setTaxEntities] = useState<TaxEntity[]>([]);
  const [mailboxes, setMailboxes] = useState<EmailAccount[]>([]);
  const [data, setData] = useState<TaxDocumentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [gmailPickerOpen, setGmailPickerOpen] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [archiving, setArchiving] = useState<{ id: number; issuer_name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIdRef = useRef(0);

  const taxEntityId = searchParams.get('tax_entity_id') ?? '';
  const taxYear = searchParams.get('tax_year') ?? '';
  const status = searchParams.get('status') ?? '';
  const documentType = searchParams.get('document_type') ?? '';
  const q = searchParams.get('q') ?? '';
  const page = Number(searchParams.get('page') ?? '1');

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
    void (async () => {
      const [entitiesResult, mailboxesResult] = await Promise.allSettled([
        req<TaxEntity[]>('/api/tax-entities'),
        req<EmailAccount[]>('/api/email-accounts'),
      ]);
      if (entitiesResult.status === 'fulfilled') setTaxEntities(entitiesResult.value);
      if (mailboxesResult.status === 'fulfilled') setMailboxes(mailboxesResult.value);
    })();
  }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (taxEntityId) p.set('tax_entity_id', taxEntityId);
    if (taxYear) p.set('tax_year', taxYear);
    if (status) p.set('status', status);
    if (documentType) p.set('document_type', documentType);
    if (q) p.set('q', q);
    p.set('limit', String(LIMIT));
    p.set('offset', String((page - 1) * LIMIT));
    return p.toString();
  }, [taxEntityId, taxYear, status, documentType, q, page]);

  const reload = async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await req<TaxDocumentListResponse>(`/api/tax-documents?${queryString}`);
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'โหลดรายการเอกสารภาษีไม่สำเร็จ');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, [queryString]);

  const rows = data?.rows ?? [];
  const totalCount = data?.total_count ?? 0;
  const taxEntityName = (id: number) => taxEntities.find((e) => e.id === id)?.display_name ?? '—';

  return (
    <Box>
      <PageHeader
        level={1}
        id="tax-documents-heading"
        title="เอกสารภาษี"
        description="เก็บและเชื่อมใบกำกับภาษี ใบเสร็จ และหนังสือรับรองต่าง ๆ เข้ากับธุรกรรมจริง ไฟล์ถูกเข้ารหัสก่อนบันทึกเสมอ"
        action={
          <Stack direction="row" spacing={1} data-tour="taxdoc-actions">
            <Button variant="outlined" startIcon={<MarkEmailReadRounded />} onClick={() => setGmailPickerOpen(true)}>เลือกจาก Gmail</Button>
            <Button variant="contained" startIcon={<AddRounded />} onClick={() => setUploadOpen(true)} sx={{ whiteSpace: 'nowrap' }}>อัปโหลด</Button>
          </Stack>
        }
      />

      <Stack direction="row" spacing={1.5} sx={{ mt: 3, flexWrap: 'wrap' }}>
        <TextField select size="small" label="Tax Entity" value={taxEntityId} onChange={(e) => setFilter({ tax_entity_id: e.target.value })} sx={{ minWidth: 160 }}>
          <MenuItem value="">ทั้งหมด</MenuItem>
          {taxEntities.map((e) => <MenuItem key={e.id} value={e.id}>{e.display_name}</MenuItem>)}
        </TextField>
        <TextField label="ปีภาษี" size="small" value={taxYear} onChange={(e) => setFilter({ tax_year: e.target.value })} sx={{ width: 110 }} slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
        <TextField select size="small" label="สถานะ" value={status} onChange={(e) => setFilter({ status: e.target.value })} sx={{ minWidth: 140 }}>
          <MenuItem value="">ทั้งหมด</MenuItem>
          <MenuItem value="draft">ฉบับร่าง</MenuItem>
          <MenuItem value="verified">ตรวจสอบแล้ว</MenuItem>
          <MenuItem value="submitted">ยื่นแล้ว</MenuItem>
        </TextField>
        <TextField select size="small" label="ประเภทเอกสาร" value={documentType} onChange={(e) => setFilter({ document_type: e.target.value })} sx={{ minWidth: 170 }}>
          <MenuItem value="">ทั้งหมด</MenuItem>
          {(Object.entries(DOCUMENT_TYPE_LABEL) as [TaxDocumentType, string][]).map(([value, label]) => (
            <MenuItem key={value} value={value}>{label}</MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="ค้นหา (ผู้ออก/เลขที่เอกสาร)"
          defaultValue={q}
          onBlur={(e) => setFilter({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') setFilter({ q: (e.target as HTMLInputElement).value }); }}
          sx={{ minWidth: 200, flexGrow: 1 }}
        />
      </Stack>

      {error && <LoadError message={error} onRetry={rows.length === 0 ? () => void reload() : undefined} />}

      {loading ? (
        <TableSkeleton rows={6} />
      ) : error && rows.length === 0 ? null : rows.length === 0 ? (
        <EmptyState
          icon={<ReceiptRounded sx={{ fontSize: 40 }} />}
          title="ยังไม่มีเอกสารภาษี"
          description="อัปโหลดเอกสารด้วยมือ หรือเลือกไฟล์แนบจาก Gmail เพื่อเริ่มเก็บหลักฐานลดหย่อนภาษี"
          action={<Button variant="contained" startIcon={<AddRounded />} onClick={() => setUploadOpen(true)}>อัปโหลดเอกสารแรก</Button>}
        />
      ) : (
        <>
          <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 3 }} data-tour="taxdoc-table">
            <Table size="small" aria-label="เอกสารภาษี" sx={{ minWidth: 780 }}>
              <TableHead>
                <TableRow>
                  <TableCell>ผู้ออกเอกสาร</TableCell>
                  <TableCell>ประเภท</TableCell>
                  <TableCell>Tax Entity</TableCell>
                  <TableCell>ปีภาษี</TableCell>
                  <TableCell align="right">ยอดรวม</TableCell>
                  <TableCell>สถานะ</TableCell>
                  <TableCell align="right">จัดการ</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((doc) => (
                  <TableRow key={doc.id} hover onClick={() => setSelectedDocId(doc.id)} sx={{ cursor: 'pointer' }}>
                    <TableCell>{doc.issuer_name}<br /><Box component="span" color="text.secondary" sx={{ fontSize: '0.875rem', ...dataTextSx }}>{doc.original_filename}</Box></TableCell>
                    <TableCell>{DOCUMENT_TYPE_LABEL[doc.document_type]}</TableCell>
                    <TableCell>{taxEntityName(doc.tax_entity_id)}</TableCell>
                    <TableCell sx={dataTextSx}>{doc.tax_year}</TableCell>
                    <TableCell align="right"><Money satang={doc.total_satang} /></TableCell>
                    <TableCell><TaxDocumentStatusChip status={doc.status} /></TableCell>
                    <TableCell align="right">
                      <Tooltip title="เก็บเข้าคลัง">
                        <IconButton
                          aria-label={`เก็บเอกสาร ${doc.issuer_name} เข้าคลัง`}
                          size="small"
                          onClick={(e) => { e.stopPropagation(); setArchiving({ id: doc.id, issuer_name: doc.issuer_name }); }}
                        >
                          <ArchiveOutlined fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={totalCount}
            page={page - 1}
            onPageChange={(_, newPage) => setFilter({ page: String(newPage + 1) })}
            rowsPerPage={LIMIT}
            rowsPerPageOptions={[LIMIT]}
            labelDisplayedRows={({ from, to, count }) => `${from}–${to} จาก ${count}`}
            sx={dataTextSx}
          />
        </>
      )}

      <TaxDocumentUploadModal
        open={uploadOpen}
        taxEntities={taxEntities}
        onClose={() => setUploadOpen(false)}
        onSaved={() => void reload()}
        onNotice={setNotice}
      />
      <GmailAttachmentPicker
        open={gmailPickerOpen}
        mailboxes={mailboxes}
        taxEntities={taxEntities}
        onClose={() => setGmailPickerOpen(false)}
        onSaved={() => void reload()}
        onNotice={setNotice}
      />
      <TaxDocumentDrawer
        docId={selectedDocId}
        taxEntities={taxEntities}
        onClose={() => setSelectedDocId(null)}
        onSaved={() => void reload()}
        onNotice={setNotice}
      />
      <ConfirmDialog
        open={Boolean(archiving)}
        title="เก็บเอกสารภาษีเข้าคลัง"
        description={`เก็บเอกสารของ "${archiving?.issuer_name ?? ''}" เข้าคลังหรือไม่? ไฟล์ยังอยู่ครบ (เข้ารหัสอยู่) แต่จะหายจากรายการนี้`}
        confirmLabel="เก็บเข้าคลัง"
        confirmColor="warning"
        busy={busy}
        onClose={() => setArchiving(null)}
        onConfirm={async () => {
          if (!archiving) return;
          setBusy(true);
          try {
            await del(`/api/tax-documents/${archiving.id}`);
            setArchiving(null);
            setNotice({ message: 'เก็บเอกสารภาษีเข้าคลังแล้ว', severity: 'success' });
            await reload();
          } catch (e) {
            setNotice({ message: e instanceof Error ? e.message : 'เก็บเข้าคลังไม่สำเร็จ', severity: 'error' });
            setArchiving(null);
          } finally {
            setBusy(false);
          }
        }}
      />
      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
