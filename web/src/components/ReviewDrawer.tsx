import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  ListSubheader,
  MenuItem,
  Select,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded';
import {
  patch, post, put, req,
  TAX_TREATMENT_LABEL,
  type Category, type Classification, type TaxEntity, type TaxTreatment, type TxnDetail, type TxnSplit,
} from '../api.js';
import { formatDate, parseBahtToSatang } from '../format.js';
import { dataTextSx } from '../theme.js';
import { LoadError, type Notice } from '../ui.js';
import IncomeQuickAddModal from './IncomeQuickAddModal.js';
import Money from './Money.js';

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  income: 'รายรับ',
  expense: 'รายจ่าย',
  internal_transfer: 'โอนภายใน',
  excluded: 'ไม่นับรวม',
};

// category_id เป็น string เสมอ (ค่าว่าง = ยังไม่เลือก) — เลี่ยงปัญหา MUI Select ที่ value เป็น union
// number | '' แล้ว TS สืบ generic type ของ onChange event ไม่ได้ตรงกับที่ประกาศ แปลงเป็น number ตอน submit
type SplitRow = { key: string; category_id: string; amountText: string; note: string };

function splitsToRows(splits: TxnSplit[]): SplitRow[] {
  return splits.map((s) => ({ key: String(s.id), category_id: String(s.category_id), amountText: (s.amount_satang / 100).toFixed(2), note: s.note ?? '' }));
}

function initialClassification(detail: TxnDetail): Classification {
  if (detail.is_internal_transfer) return 'internal_transfer';
  if (detail.classification) return detail.classification;
  return detail.direction === 'credit' ? 'income' : 'expense';
}

type ReviewDrawerProps = {
  txnId: number | null;
  categories: Category[];
  taxEntities: TaxEntity[];
  onClose: () => void;
  onSaved: () => void;
  onNotice: (notice: Notice) => void;
};

// Drawer เดียวทำสามงาน: จัดประเภท, แยกยอดหลายหมวด, ยืนยัน/ปฏิเสธคู่โอนที่ระบบ suggest ไว้ —
// นี่คือจุดแรกที่ผู้ใช้เห็นและกดยืนยัน suggested transfer match จริง (ย้ายมาจาก 4A ตาม 4b-dashboard.md)
export default function ReviewDrawer({ txnId, categories, taxEntities, onClose, onSaved, onNotice }: ReviewDrawerProps) {
  const [detail, setDetail] = useState<TxnDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [classification, setClassification] = useState<Classification>('expense');
  const [note, setNote] = useState('');
  const [taxEntityOverride, setTaxEntityOverride] = useState('');
  const [taxTreatment, setTaxTreatment] = useState('');
  const [incomeModalOpen, setIncomeModalOpen] = useState(false);
  const [savingClassification, setSavingClassification] = useState(false);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [savingSplits, setSavingSplits] = useState(false);
  const [actingMatchId, setActingMatchId] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  // กันคำขอที่มาไม่เรียงลำดับ (คลิกแถว A แล้ว B เร็ว ๆ ถ้า A ตอบช้ากว่าจะเขียนทับรายละเอียดของ B ที่กำลังเปิดอยู่)
  const load = async (id: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    try {
      const d = await req<TxnDetail>(`/api/transactions/${id}`);
      if (requestId !== requestIdRef.current) return;
      setDetail(d);
      setClassification(initialClassification(d));
      setNote(d.annotation_note ?? '');
      setTaxEntityOverride(d.tax_entity_id == null ? '' : String(d.tax_entity_id));
      setTaxTreatment(d.tax_treatment ?? '');
      setSplits(splitsToRows(d.splits));
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'โหลดรายละเอียดไม่สำเร็จ');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (txnId != null) void load(txnId);
  }, [txnId]);

  const saveClassification = async () => {
    if (!detail) return;
    setSavingClassification(true);
    try {
      const updated = await patch<{ classification: Classification; note: string | null; review_status: string; tax_entity_id: number | null; tax_treatment: TaxTreatment | null }>(
        `/api/transactions/${detail.id}/annotation`,
        {
          classification, note: note || null,
          tax_entity_id: taxEntityOverride === '' ? null : Number(taxEntityOverride),
          tax_treatment: taxTreatment === '' ? null : taxTreatment,
        },
      );
      setDetail((d) => (d ? {
        ...d, classification: updated.classification, review_status: 'reviewed',
        annotation_note: updated.note, tax_entity_id: updated.tax_entity_id, tax_treatment: updated.tax_treatment,
      } : d));
      onNotice({ message: 'บันทึกการจัดประเภทแล้ว', severity: 'success' });
      onSaved();
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'บันทึกการจัดประเภทไม่สำเร็จ', severity: 'error' });
    } finally {
      setSavingClassification(false);
    }
  };

  const splitTotalSatang = splits.reduce((sum, s) => sum + (parseBahtToSatang(s.amountText) ?? 0), 0);
  const remainingSatang = detail ? detail.amount_satang - splitTotalSatang : 0;
  const splitsRowsValid = splits.every((s) => s.category_id !== '' && parseBahtToSatang(s.amountText) !== null && (parseBahtToSatang(s.amountText) ?? 0) > 0);

  const saveSplits = async () => {
    if (!detail) return;
    if (!splitsRowsValid) {
      onNotice({ message: 'กรอกหมวดและจำนวนเงินให้ครบทุกแถว', severity: 'error' });
      return;
    }
    setSavingSplits(true);
    try {
      const payload = splits.map((s) => ({
        category_id: Number(s.category_id),
        amount_satang: parseBahtToSatang(s.amountText)!,
        note: s.note || null,
      }));
      const saved = await put<{ id: number; category_id: number; amount_satang: number; note: string | null }[]>(
        `/api/transactions/${detail.id}/splits`,
        payload,
      );
      const withNames = saved.map((s) => ({ ...s, category_name: categories.find((c) => c.id === s.category_id)?.name ?? '' }));
      setDetail((d) => (d ? { ...d, splits: withNames } : d));
      setSplits(splitsToRows(withNames));
      onNotice({ message: splits.length === 0 ? 'ล้างการแยกยอดแล้ว' : 'บันทึกการแยกยอดแล้ว', severity: 'success' });
      onSaved();
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'บันทึกการแยกยอดไม่สำเร็จ', severity: 'error' });
    } finally {
      setSavingSplits(false);
    }
  };

  const actOnMatch = async (matchId: number, action: 'confirm' | 'reject') => {
    if (!detail) return;
    setActingMatchId(matchId);
    try {
      await post(`/api/transfer-matches/${matchId}/${action}`, {});
      onNotice({ message: action === 'confirm' ? 'ยืนยันคู่โอนภายในแล้ว' : 'ปฏิเสธคู่โอนที่ระบบเสนอแล้ว', severity: 'success' });
      await load(detail.id);
      onSaved();
    } catch (e) {
      onNotice({ message: e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ', severity: 'error' });
    } finally {
      setActingMatchId(null);
    }
  };

  const incomeCategories = categories.filter((c) => c.kind === 'income');
  const expenseCategories = categories.filter((c) => c.kind === 'expense');

  return (
    <Drawer anchor="right" open={txnId != null} onClose={onClose} slotProps={{ paper: { 'aria-labelledby': 'review-drawer-heading' } }}>
      <Box sx={{ width: { xs: '100vw', sm: 440 }, p: 3, height: '100%', overflowY: 'auto' }}>
        <Stack direction="row" sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h2" id="review-drawer-heading" sx={{ fontSize: '1.25rem' }}>รายละเอียดธุรกรรม</Typography>
          <IconButton aria-label="ปิด" onClick={onClose}><CloseRounded /></IconButton>
        </Stack>

        {error && <LoadError message={error} onRetry={txnId != null ? () => void load(txnId) : undefined} />}

        {loading ? (
          <Stack spacing={2}>
            <Skeleton variant="rounded" height={80} />
            <Skeleton variant="rounded" height={140} />
            <Skeleton variant="rounded" height={140} />
          </Stack>
        ) : detail && !error ? (
          <Stack spacing={3}>
            <Box>
              <Typography sx={{ fontWeight: 650 }}>{detail.description}</Typography>
              <Typography variant="body2" color="text.secondary" sx={dataTextSx}>
                {formatDate(detail.txn_date)} · {detail.account_nickname} ({detail.bank_name})
              </Typography>
              <Money
                satang={detail.direction === 'debit' ? -detail.amount_satang : detail.amount_satang}
                tone={detail.direction === 'credit' ? 'income' : 'expense'}
                showSign
                sx={{ fontSize: '1.75rem', display: 'block', mt: 1 }}
              />
            </Box>

            <Divider />

            <Box component="section" aria-labelledby="classification-heading">
              <Typography variant="h2" id="classification-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>จัดประเภทรายการ</Typography>
              <Stack spacing={1.5}>
                <TextField select label="ประเภท" value={classification} onChange={(e) => setClassification(e.target.value as Classification)} size="small">
                  {(Object.entries(CLASSIFICATION_LABEL) as [Classification, string][]).map(([value, label]) => (
                    <MenuItem key={value} value={value}>{label}</MenuItem>
                  ))}
                </TextField>
                <TextField label="โน้ต (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} size="small" multiline minRows={2} slotProps={{ htmlInput: { maxLength: 500 } }} />
                {classification === 'income' && detail.direction === 'credit' && (
                  <Alert
                    severity="info"
                    action={<Button size="small" onClick={() => setIncomeModalOpen(true)}>บันทึกเป็นรายได้เต็ม</Button>}
                  >
                    ถ้านี่คือเงินเดือนหรือรายได้ประจำ กดปุ่มนี้เพื่อบันทึกเป็น "รายได้เต็ม" ได้เลย —
                    จะขึ้นเป็น "เงินได้จากงานประจำ" ในหน้าภาษี ส่วน Tax Treatment ด้านล่างมีไว้สำหรับรายได้ธุรกิจอื่นเท่านั้น
                  </Alert>
                )}
                <TextField
                  select
                  label="Tax Entity"
                  helperText={
                    detail.account_default_tax_entity_id != null
                      ? 'ไม่เลือก = ใช้ค่าเริ่มต้นจากบัญชีนี้'
                      : taxEntities.length === 1
                        ? `ไม่เลือกก็ได้ — มี Tax Entity เดียว ระบบผูกให้เป็น "${taxEntities[0]!.display_name}" เอง`
                        : 'บัญชีนี้ยังไม่ได้ตั้งค่าเริ่มต้น — เลือกเองต่อรายการ หรือไปตั้งค่าเริ่มต้นที่หน้าบัญชีของฉัน'
                  }
                  value={taxEntityOverride}
                  onChange={(e) => setTaxEntityOverride(e.target.value)}
                  size="small"
                >
                  <MenuItem value=""><em>ใช้ค่าเริ่มต้นจากบัญชี</em></MenuItem>
                  {taxEntities.map((te) => <MenuItem key={te.id} value={te.id}>{te.display_name}</MenuItem>)}
                </TextField>
                <TextField
                  select
                  label="Tax Treatment (สำหรับคำนวณภาษี)"
                  helperText={
                    detail.direction === 'credit'
                      ? 'เงินเดือน/รายได้ประจำ ไม่ต้องตั้งตรงนี้ — ใช้ปุ่ม "บันทึกเป็นรายได้เต็ม" ด้านบน เลือก "รายได้ธุรกิจ" เฉพาะรายได้ธุรกิจ/ฟรีแลนซ์'
                      : 'เลือก "ค่าใช้จ่ายหักภาษีได้" เฉพาะรายจ่ายที่หักภาษีได้จริง — ระบบไม่เดาให้เพราะเงินออกจากบัญชีไม่ได้แปลว่าหักภาษีได้'
                  }
                  value={taxTreatment}
                  onChange={(e) => setTaxTreatment(e.target.value)}
                  size="small"
                >
                  <MenuItem value=""><em>ยังไม่ระบุ</em></MenuItem>
                  {(Object.entries(TAX_TREATMENT_LABEL) as [TaxTreatment, string][]).map(([value, label]) => (
                    <MenuItem key={value} value={value}>{label}</MenuItem>
                  ))}
                </TextField>
                {taxTreatment === '' && (taxEntityOverride !== '' || detail.account_default_tax_entity_id != null) && (
                  <Alert severity="warning">
                    ตั้ง Tax Entity ไว้แล้ว แต่ยังไม่ได้เลือก Tax Treatment — รายการนี้จะ<strong>ยังไม่ถูกนับ</strong>ในหน้าประมาณการภาษี
                    (ไปโผล่ที่ตัวนับ "ยังไม่ระบุ Tax Treatment" แทน) ถ้าต้องการให้นับเป็น
                    {detail.direction === 'credit' ? 'รายได้ธุรกิจ ให้เลือก "รายได้ธุรกิจ" ด้านบน' : 'ค่าใช้จ่ายหักภาษีได้ ให้เลือก "ค่าใช้จ่ายหักภาษีได้" ด้านบน'}
                  </Alert>
                )}
                <Button variant="contained" onClick={() => void saveClassification()} disabled={savingClassification} aria-busy={savingClassification} sx={{ alignSelf: 'flex-start' }}>
                  {savingClassification ? 'กำลังบันทึก…' : 'บันทึกการจัดประเภท'}
                </Button>
              </Stack>
            </Box>

            <Divider />

            <Box component="section" aria-labelledby="splits-heading">
              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                <Typography variant="h2" id="splits-heading" sx={{ fontSize: '1.25rem' }}>แยกยอดตามหมวด</Typography>
                <Button
                  size="small"
                  startIcon={<AddRounded />}
                  onClick={() => setSplits((rows) => [...rows, { key: crypto.randomUUID(), category_id: '', amountText: '', note: '' }])}
                >
                  เพิ่มรายการ
                </Button>
              </Stack>

              {splits.length === 0 ? (
                <Typography variant="body2" color="text.secondary">ยังไม่ได้แยกยอด — ทั้งจำนวนจะถือเป็นรายการเดียวไม่มีหมวดย่อย</Typography>
              ) : (
                <Stack spacing={1.5}>
                  {splits.map((row, index) => (
                    <Stack key={row.key} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                      <Select
                        size="small"
                        value={row.category_id}
                        displayEmpty
                        onChange={(e) => setSplits((rows) => rows.map((r, i) => (i === index ? { ...r, category_id: e.target.value } : r)))}
                        sx={{ flex: 1, minWidth: 0 }}
                      >
                        <MenuItem value=""><em>เลือกหมวด</em></MenuItem>
                        <ListSubheader>รายรับ</ListSubheader>
                        {incomeCategories.map((c) => <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>)}
                        <ListSubheader>รายจ่าย</ListSubheader>
                        {expenseCategories.map((c) => <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>)}
                      </Select>
                      <TextField
                        size="small"
                        label="บาท"
                        value={row.amountText}
                        onChange={(e) => setSplits((rows) => rows.map((r, i) => (i === index ? { ...r, amountText: e.target.value } : r)))}
                        slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
                        sx={{ width: 110 }}
                      />
                      <IconButton
                        aria-label="ลบรายการนี้"
                        onClick={() => setSplits((rows) => rows.filter((_, i) => i !== index))}
                        sx={{ mt: 0.5 }}
                      >
                        <DeleteOutlineRounded />
                      </IconButton>
                    </Stack>
                  ))}
                  <Typography variant="body2" color={remainingSatang === 0 ? 'text.secondary' : 'error'} sx={dataTextSx}>
                    {remainingSatang === 0 ? 'ยอดรวมครบพอดี' : `เหลือ ${remainingSatang > 0 ? 'ที่ยังไม่ได้แยก' : 'เกินยอดจริง'} ${(Math.abs(remainingSatang) / 100).toFixed(2)} บาท`}
                  </Typography>
                </Stack>
              )}

              <Button
                variant="outlined"
                onClick={() => void saveSplits()}
                disabled={savingSplits || (splits.length > 0 && (remainingSatang !== 0 || !splitsRowsValid))}
                aria-busy={savingSplits}
                sx={{ mt: 1.5 }}
              >
                {savingSplits ? 'กำลังบันทึก…' : splits.length === 0 ? 'บันทึก (ล้างการแยกยอด)' : 'บันทึกการแยกยอด'}
              </Button>
            </Box>

            {detail.transfer_matches.length > 0 && (
              <>
                <Divider />
                <Box component="section" aria-labelledby="transfer-heading">
                  <Typography variant="h2" id="transfer-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>คู่โอนภายในที่ระบบพบ</Typography>
                  <Stack spacing={1.5}>
                    {detail.transfer_matches.map((m) => (
                      <Box key={m.id} sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: '10px' }}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                          <SwapHorizRounded fontSize="small" sx={{ color: 'text.secondary' }} />
                          <Typography variant="body2" sx={{ fontWeight: 650 }}>{m.counterpart_account_nickname}</Typography>
                          {m.status === 'confirmed' && <Chip size="small" icon={<CheckRounded />} label="ยืนยันแล้ว" color="success" variant="outlined" />}
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={dataTextSx}>
                          {formatDate(m.counterpart_txn_date)} · <Money satang={m.counterpart_amount_satang} />
                        </Typography>
                        {m.status === 'suggested' && (
                          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                            <Button
                              size="small"
                              variant="contained"
                              disabled={actingMatchId === m.id}
                              aria-busy={actingMatchId === m.id}
                              onClick={() => void actOnMatch(m.id, 'confirm')}
                            >
                              ยืนยันว่าเป็นคู่โอน
                            </Button>
                            <Button
                              size="small"
                              color="inherit"
                              disabled={actingMatchId === m.id}
                              onClick={() => void actOnMatch(m.id, 'reject')}
                            >
                              ไม่ใช่
                            </Button>
                          </Stack>
                        )}
                      </Box>
                    ))}
                  </Stack>
                </Box>
              </>
            )}

            {detail.statement_id && (detail.period_start || detail.period_end) && (
              <Alert severity="info" variant="outlined">
                มาจาก statement {detail.period_start ? formatDate(detail.period_start) : '—'} – {detail.period_end ? formatDate(detail.period_end) : '—'}
              </Alert>
            )}
          </Stack>
        ) : null}
      </Box>
      {detail && (
        <IncomeQuickAddModal
          txn={detail}
          open={incomeModalOpen}
          onClose={() => setIncomeModalOpen(false)}
          onCreated={() => {
            onNotice({ message: 'บันทึกรายได้เต็มแล้ว — ดูยอดได้ที่หน้าภาษี', severity: 'success' });
            onSaved();
          }}
        />
      )}
    </Drawer>
  );
}
