import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded';
import { del, patch, post, req, type TaxDeductionClaim, type TaxDocument } from '../api.js';
import Modal from '../Modal.js';
import { formatBaht, parseBahtToSatang } from '../format.js';
import { ConfirmDialog, EmptyState, LoadError, TableSkeleton } from '../ui.js';
import Money from './Money.js';

// รายการเดียวกับ src/services/tax-rules.ts (DEDUCTION_TYPES) — ไม่มี 'personal' เพราะลดหย่อนส่วนตัว
// มาจาก personalAllowanceSatang ในสูตรอยู่แล้ว เปิดให้กรอกที่นี่ด้วยจะนับซ้ำ
const DEDUCTION_TYPE_LABEL: Record<string, string> = {
  spouse: 'คู่สมรส',
  child: 'บุตร',
  parent: 'บิดามารดา',
  life_insurance: 'ประกันชีวิต',
  health_insurance: 'ประกันสุขภาพ',
  social_security: 'ประกันสังคม',
  provident_fund: 'กองทุนสำรองเลี้ยงชีพ',
  ssf: 'SSF',
  rmf: 'RMF',
  mortgage_interest: 'ดอกเบี้ยเงินกู้ที่อยู่อาศัย',
  donation: 'เงินบริจาค',
  other: 'อื่น ๆ',
};

type Form = { deduction_type: string; eligible: string; claimed: string; tax_document_id: string; note: string };
const emptyForm = (): Form => ({ deduction_type: 'donation', eligible: '', claimed: '', tax_document_id: '', note: '' });

function amount(value: string): number {
  const result = parseBahtToSatang(value);
  if (result == null) throw new Error('กรุณากรอกจำนวนเงินบาทให้ถูกต้อง ไม่เกิน 2 ตำแหน่งทศนิยม');
  return result;
}

type Props = { taxEntityId: number; taxYear: number; onChanged: () => void };

// ค่าลดหย่อน (§7.5 tax_deduction_claim) — ลบได้จริงไม่ใช่ archive (ดูคอมเมนต์ migration 010) เพราะ
// audit_log เก็บ before_data ทั้งแถวไว้แล้ว และ snapshot ที่คำนวณไปแล้วก็ freeze ยอดไว้แล้ว
export default function DeductionClaimSection({ taxEntityId, taxYear, onChanged }: Props) {
  const [rows, setRows] = useState<TaxDeductionClaim[]>([]);
  const [documents, setDocuments] = useState<TaxDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<TaxDeductionClaim | 'new' | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TaxDeductionClaim | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    Promise.all([
      req<{ rows: TaxDeductionClaim[] }>(`/api/tax/deduction-claims?tax_entity_id=${taxEntityId}&tax_year=${taxYear}`),
      req<{ rows: TaxDocument[] }>(`/api/tax-documents?tax_entity_id=${taxEntityId}&tax_year=${taxYear}&limit=200`),
    ])
      .then(([claims, docs]) => { if (current) { setRows(claims.rows); setDocuments(docs.rows); } })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [taxEntityId, taxYear, revision]);

  const refresh = async () => { setRevision((n) => n + 1); onChanged(); };
  const openEditor = (claim: TaxDeductionClaim | 'new') => {
    setFormError(''); setEditing(claim);
    setForm(claim === 'new' ? emptyForm() : {
      deduction_type: claim.deduction_type,
      eligible: formatBaht(claim.eligible_amount_satang),
      claimed: formatBaht(claim.claimed_amount_satang),
      tax_document_id: claim.tax_document_id == null ? '' : String(claim.tax_document_id),
      note: claim.note ?? '',
    });
  };

  const save = async () => {
    setBusy(true); setFormError('');
    try {
      const eligible = amount(form.eligible);
      const claimed = amount(form.claimed);
      if (claimed > eligible) throw new Error('ยอดที่ยื่นขอต้องไม่เกินยอดที่มีสิทธิ์');
      const body = {
        eligible_amount_satang: eligible,
        claimed_amount_satang: claimed,
        tax_document_id: form.tax_document_id ? Number(form.tax_document_id) : null,
        note: form.note || null,
      };
      if (editing === 'new') {
        await post('/api/tax/deduction-claims', { ...body, tax_entity_id: taxEntityId, tax_year: taxYear, deduction_type: form.deduction_type });
      } else if (editing) {
        await patch(`/api/tax/deduction-claims/${editing.id}`, body);
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'บันทึกค่าลดหย่อนไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box component="section" aria-labelledby="deduction-claim-heading">
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h2" id="deduction-claim-heading" sx={{ fontSize: '1.25rem' }}>ค่าลดหย่อน</Typography>
        <Button size="small" startIcon={<AddRounded />} onClick={() => openEditor('new')}>เพิ่มค่าลดหย่อน</Button>
      </Stack>

      {error && <LoadError message={error} onRetry={() => setRevision((n) => n + 1)} />}
      {loading ? <TableSkeleton rows={2} /> : !error && (rows.length === 0 ? (
        <EmptyState icon={<ReceiptLongRounded sx={{ fontSize: 40 }} />} title="ยังไม่มีค่าลดหย่อนที่บันทึกไว้" description="เพิ่มค่าลดหย่อนที่มีเอกสารรองรับ เพื่อให้ประมาณการภาษีแม่นยำขึ้น" />
      ) : (
        <TableContainer component={Paper} variant="outlined" tabIndex={0}>
          <Table size="small" aria-label="ค่าลดหย่อน" sx={{ minWidth: 600 }}>
            <TableHead>
              <TableRow>
                <TableCell>ประเภท</TableCell>
                <TableCell align="right">มีสิทธิ์</TableCell>
                <TableCell align="right">ยื่นขอ</TableCell>
                <TableCell>เอกสาร</TableCell>
                <TableCell>จัดการ</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((claim) => (
                <TableRow key={claim.id} hover>
                  <TableCell>{DEDUCTION_TYPE_LABEL[claim.deduction_type] ?? claim.deduction_type}</TableCell>
                  <TableCell align="right"><Money satang={claim.eligible_amount_satang} /></TableCell>
                  <TableCell align="right"><Money satang={claim.claimed_amount_satang} /></TableCell>
                  <TableCell>{claim.tax_document_id == null ? <Typography variant="body2" color="text.secondary">ไม่ผูกเอกสาร</Typography> : `#${claim.tax_document_id}`}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      <Button size="small" onClick={() => openEditor(claim)}>แก้ไข</Button>
                      <Button size="small" color="error" startIcon={<DeleteOutlineRounded />} onClick={() => setDeleting(claim)}>ลบ</Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ))}

      <Modal open={editing != null} title={editing === 'new' ? 'เพิ่มค่าลดหย่อน' : 'แก้ไขค่าลดหย่อน'} onClose={() => setEditing(null)} busy={busy}>
        <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <TextField
            select label="ประเภทค่าลดหย่อน" required disabled={editing !== 'new'}
            value={form.deduction_type} onChange={(e) => setForm({ ...form, deduction_type: e.target.value })}
          >
            {Object.entries(DEDUCTION_TYPE_LABEL).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
          </TextField>
          <TextField label="ยอดที่มีสิทธิ์ (บาท)" required value={form.eligible} onChange={(e) => setForm({ ...form, eligible: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
          <TextField label="ยอดที่ยื่นขอ (บาท)" required value={form.claimed} onChange={(e) => setForm({ ...form, claimed: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
          <TextField select label="เอกสารอ้างอิง" value={form.tax_document_id} onChange={(e) => setForm({ ...form, tax_document_id: e.target.value })} helperText="ไม่บังคับ แต่ต้องมีก่อนถือว่าตรวจสอบครบ">
            <MenuItem value="">ไม่ผูกเอกสาร</MenuItem>
            {documents.map((d) => <MenuItem key={d.id} value={d.id}>{d.issuer_name} · {d.document_no ?? `#${d.id}`}</MenuItem>)}
          </TextField>
          <TextField label="โน้ต (ไม่บังคับ)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} multiline minRows={2} slotProps={{ htmlInput: { maxLength: 500 } }} />
          {formError && <Alert severity="error">{formError}</Alert>}
          <Button type="submit" variant="contained" disabled={busy} aria-busy={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึก'}</Button>
        </Stack>
      </Modal>

      <ConfirmDialog
        open={deleting != null}
        title="ลบค่าลดหย่อน"
        description={`ลบค่าลดหย่อน "${deleting ? (DEDUCTION_TYPE_LABEL[deleting.deduction_type] ?? deleting.deduction_type) : ''}" — การลบนี้ทำจริง ย้อนกลับไม่ได้ (ประวัติยังอยู่ใน Audit Log)`}
        confirmLabel="ลบ"
        confirmColor="error"
        busy={busy}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          setBusy(true);
          void del(`/api/tax/deduction-claims/${deleting.id}`)
            .then(async () => { setDeleting(null); await refresh(); })
            .catch((e: Error) => { setDeleting(null); setError(e.message); })
            .finally(() => setBusy(false));
        }}
      />
    </Box>
  );
}
