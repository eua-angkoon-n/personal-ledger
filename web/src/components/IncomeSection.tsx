import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import { post, patch, req, type Account, type IncomeDeduction, type IncomeRecord, type PlanItem } from '../api.js';
import Modal from '../Modal.js';
import { formatBaht, formatDate, parseBahtToSatang } from '../format.js';
import { ConfirmDialog, LoadError, PageHeader, TableSkeleton } from '../ui.js';
import Money from './Money.js';

const DEDUCTIONS = { social_security: 'ประกันสังคม', withholding_tax: 'ภาษีหัก ณ ที่จ่าย', other: 'รายการหักอื่น' };
type DeductionForm = { deduction_type: IncomeDeduction['deduction_type']; name: string; amount: string; monthly_plan_item_id: string };
type Form = { name: string; gross: string; monthly_plan_item_id: string; bank_account_id: string; income_date: string; deductions: DeductionForm[] };
const emptyForm = (): Form => ({ name: '', gross: '', monthly_plan_item_id: '', bank_account_id: '', income_date: '', deductions: [] });

function amount(value: string): number {
  const result = parseBahtToSatang(value);
  if (result == null || !Number.isSafeInteger(result)) throw new Error('กรุณากรอกจำนวนเงินบาทให้ถูกต้อง ไม่เกิน 2 ตำแหน่งทศนิยม');
  return result;
}

export default function IncomeSection({ month, closed, items, onChanged }: { month: string; closed: boolean; items: PlanItem[]; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<IncomeRecord[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<IncomeRecord | 'new' | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setLoading(true); setError('');
    Promise.all([req<{ rows: IncomeRecord[] }>(`/api/income-records?month=${month}`), req<Account[]>('/api/accounts')])
      .then(([income, banks]) => { if (current) { setRows(income.rows); setAccounts(banks); } })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [month, revision]);


  const refresh = async () => { setRevision((n) => n + 1); await onChanged(); };
  const openEditor = (income: IncomeRecord | 'new') => {
    setFormError(''); setEditing(income);
    setForm(income === 'new' ? emptyForm() : {
      name: income.name, gross: formatBaht(income.gross_amount_satang), monthly_plan_item_id: String(income.monthly_plan_item_id),
      bank_account_id: income.bank_account_id == null ? '' : String(income.bank_account_id), income_date: income.income_date ?? '',
      deductions: income.deductions.map((d) => ({ deduction_type: d.deduction_type, name: d.name, amount: formatBaht(d.amount_satang), monthly_plan_item_id: String(d.monthly_plan_item_id) })),
    });
  };
  const available = (kind: PlanItem['kind'], selected = '') => items.filter((item) =>
    item.kind === kind && (String(item.id) === selected || (item.income_record_id == null && item.installment_due_id == null && item.explicit_status === 'active' && !item.payments.some((p) => p.status !== 'cancelled'))));
  const updateDeduction = (index: number, changes: Partial<DeductionForm>) => setForm((f) => ({ ...f, deductions: f.deductions.map((d, i) => i === index ? { ...d, ...changes } : d) }));
  const save = async () => {
    setBusy(true); setFormError('');
    try {
      const deductions = form.deductions.map((d) => ({ deduction_type: d.deduction_type, name: d.name, amount_satang: amount(d.amount), ...(d.monthly_plan_item_id ? { monthly_plan_item_id: Number(d.monthly_plan_item_id) } : {}) }));
      const body = { name: form.name, gross_amount_satang: amount(form.gross), bank_account_id: form.bank_account_id ? Number(form.bank_account_id) : null, income_date: form.income_date || null, deductions };
      if (editing === 'new') await post('/api/income-records', { ...body, month, ...(form.monthly_plan_item_id ? { monthly_plan_item_id: Number(form.monthly_plan_item_id) } : {}) });
      else if (editing) await patch(`/api/income-records/${editing.id}`, body);
      setEditing(null); await refresh();
    } catch (e) { setFormError(e instanceof Error ? e.message : 'บันทึกรายได้ไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  let preview: number | null = null;
  try { preview = amount(form.gross) - form.deductions.reduce((sum, d) => sum + amount(d.amount), 0); } catch { /* incomplete form */ }

  return <Box component="section" aria-labelledby="income-heading">
    <PageHeader id="income-heading" title="รายได้และรายการหัก" description="บันทึกรายได้เต็มและรายการหัก — ยอดสุทธิเป็นตัวเลขอ้างอิง ไม่ได้จับคู่กับ statement" action={<Button startIcon={<AddRounded />} variant="outlined" disabled={closed || loading || Boolean(error)} onClick={() => openEditor('new')}>เพิ่มรายได้เต็ม</Button>} />
    {error && <LoadError message={error} onRetry={() => setRevision((n) => n + 1)} />}
    {loading ? <TableSkeleton rows={2} /> : !error && (rows.length === 0 ? <Typography color="text.secondary" sx={{ mt: 2 }}>ยังไม่มีรายได้เต็มในเดือนนี้ เลือกเชื่อมรายได้เดิมในแผน หรือเพิ่มรายการใหม่ได้</Typography> :
      <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 2 }}>
        <Table size="small" aria-label="รายได้เต็มและเงินเข้าสุทธิ" sx={{ minWidth: 760 }}>
          <TableHead><TableRow><TableCell>รายได้</TableCell><TableCell align="right">รายได้เต็ม</TableCell><TableCell align="right">หักทั้งหมด</TableCell><TableCell align="right">สุทธิ</TableCell><TableCell>จัดการ</TableCell></TableRow></TableHead>
          <TableBody>{rows.map((income) => <TableRow key={income.id}>
            <TableCell>{income.name}<Typography variant="body2" color="text.secondary">{income.income_date ? formatDate(income.income_date) : 'ยังไม่กำหนดวันรับเงิน'}</Typography></TableCell>
            <TableCell align="right"><Money satang={income.gross_amount_satang} /></TableCell>
            <TableCell align="right"><Money satang={income.gross_amount_satang - income.expected_net_satang} /></TableCell>
            <TableCell align="right"><Money satang={income.expected_net_satang} tone="income" /></TableCell>
            <TableCell><Stack direction="row" spacing={0.5}>
              <Button disabled={closed} onClick={() => openEditor(income)}>แก้ไข</Button>
            </Stack></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </TableContainer>)}
    <Modal open={editing != null} title={editing === 'new' ? 'เพิ่มรายได้เต็ม' : 'แก้ไขรายได้เต็ม'} onClose={() => setEditing(null)} busy={busy}>
      <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {editing === 'new' && <TextField select label="เชื่อมรายได้ในแผน" value={form.monthly_plan_item_id} onChange={(e) => { const item = items.find((i) => String(i.id) === e.target.value); setForm({ ...form, monthly_plan_item_id: e.target.value, ...(item ? { name: item.name, gross: formatBaht(item.planned_amount_satang) } : {}) }); }} helperText="แสดงเฉพาะรายการที่ยังไม่เชื่อมและไม่มีการบันทึกจ่ายที่ใช้งาน">
          <MenuItem value="">สร้างรายการใหม่</MenuItem>{available('income').map((item) => <MenuItem key={item.id} value={String(item.id)}>{item.name}</MenuItem>)}
        </TextField>}
        <TextField label="ชื่อรายได้" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField label="รายได้เต็ม (บาท)" required value={form.gross} onChange={(e) => setForm({ ...form, gross: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
        <Typography variant="h3">รายการหักจากรายได้</Typography>
        {form.deductions.map((d, index) => <Box key={index} sx={{ borderBottom: 1, borderColor: 'divider', pb: 2 }}>
          <Stack spacing={1.5}>
            <TextField select label={`ประเภทการหัก ${index + 1}`} value={d.deduction_type} onChange={(e) => updateDeduction(index, { deduction_type: e.target.value as DeductionForm['deduction_type'] })}>{Object.entries(DEDUCTIONS).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField>
            <TextField select label="เชื่อมรายการหักในแผน" value={d.monthly_plan_item_id} onChange={(e) => { const item = items.find((i) => String(i.id) === e.target.value); updateDeduction(index, { monthly_plan_item_id: e.target.value, ...(item ? { name: item.name, amount: formatBaht(item.planned_amount_satang) } : {}) }); }}>
              <MenuItem value="">สร้างรายการหักใหม่</MenuItem>{available('payroll_deduction', d.monthly_plan_item_id).filter((i) => !form.deductions.some((other, n) => n !== index && other.monthly_plan_item_id === String(i.id))).map((i) => <MenuItem key={i.id} value={String(i.id)}>{i.name}</MenuItem>)}
            </TextField>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField fullWidth label="ชื่อรายการหัก" required value={d.name} onChange={(e) => updateDeduction(index, { name: e.target.value })} />
              <TextField fullWidth label="ยอดหัก (บาท)" required value={d.amount} onChange={(e) => updateDeduction(index, { amount: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
              <Button color="error" aria-label={`ลบรายการหัก ${index + 1}`} onClick={() => setForm({ ...form, deductions: form.deductions.filter((_, i) => i !== index) })}>ลบ</Button>
            </Stack>
          </Stack>
        </Box>)}
        <Button onClick={() => setForm({ ...form, deductions: [...form.deductions, { deduction_type: 'other', name: '', amount: '', monthly_plan_item_id: '' }] })}>เพิ่มรายการหัก</Button>
        {preview != null && <Typography aria-live="polite">ยอดสุทธิหลังหัก: <Money satang={preview} tone={preview < 0 ? 'expense' : 'income'} /></Typography>}
        <TextField select label="บัญชีรับเงิน" value={form.bank_account_id} onChange={(e) => setForm({ ...form, bank_account_id: e.target.value })}><MenuItem value="">ยังไม่ระบุ</MenuItem>{accounts.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.nickname}</MenuItem>)}</TextField>
        <TextField label="วันที่รับเงิน" type="date" value={form.income_date} onChange={(e) => setForm({ ...form, income_date: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        {formError && <Alert severity="error">{formError}</Alert>}
        <Button type="submit" variant="contained" disabled={busy || (preview != null && preview < 0)}>{busy ? 'กำลังบันทึก…' : 'บันทึกรายได้'}</Button>
      </Stack>
    </Modal>
  </Box>;
}
