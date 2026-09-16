import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Chip, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import { patch, post, req, type Account, type Category, type InstallmentDetail, type InstallmentDue, type InstallmentPlan, type InstallmentTotals, type PlanItemPayment, type TxnListResponse } from '../api.js';
import Modal from '../Modal.js';
import Money from '../components/Money.js';
import { formatBaht, formatDate, parseBahtToSatang } from '../format.js';
import { ConfirmDialog, EmptyState, LoadError, PageHeader, TableSkeleton } from '../ui.js';

const STATUS = { active: 'กำลังผ่อน', completed: 'ชำระครบแล้ว', cancelled: 'ยกเลิกแล้ว' };
const DUE_STATUS = { planned: 'รอชำระ', partially_paid: 'จ่ายบางส่วน', paid: 'จ่ายครบแล้ว', overdue: 'เกินกำหนด', skipped: 'ข้ามงวด — ยังมีหนี้', cancelled: 'ยกเลิกแล้ว' };
const PAYMENT_STATUS = { declared: 'จ่ายแล้ว', cancelled: 'ยกเลิกแล้ว' };
const MONEY_FIELDS = { total_amount_satang: 'ราคาซื้อ (บาท)', down_payment_satang: 'เงินดาวน์ (บาท)', interest_satang: 'ดอกเบี้ยรวม (บาท)', fee_satang: 'ค่าธรรมเนียมรวม (บาท)' };
type MoneyField = keyof typeof MONEY_FIELDS;
type Form = Record<MoneyField, string> & { name: string; installment_count: string; frequency_unit: 'day' | 'month' | 'year'; frequency_interval: string; first_due_date: string; down_payment_date: string; default_account_id: string; category_id: string };
function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
const emptyForm = (): Form => ({ name: '', total_amount_satang: '', down_payment_satang: '0', interest_satang: '0', fee_satang: '0', installment_count: '12', frequency_unit: 'month', frequency_interval: '1', first_due_date: today(), down_payment_date: '', default_account_id: '', category_id: '' });
function readAmount(value: string) {
  const n = parseBahtToSatang(value);
  if (n == null || !Number.isSafeInteger(n)) throw new Error('กรุณากรอกจำนวนเงินบาทให้ถูกต้อง ไม่เกิน 2 ตำแหน่งทศนิยม');
  return n;
}
function Totals({ totals }: { totals: InstallmentTotals }) {
  return <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2, my: 3 }}>
    {([['ต้องชำระทั้งหมด', totals.total_payable_satang], ['จ่ายแล้ว', totals.paid_satang], ['คงเหลือ', totals.outstanding_satang]] as const).map(([label, value]) => <Box key={label}><Typography component="dt" variant="body2" color="text.secondary">{label}</Typography><Box component="dd" sx={{ m: 0, mt: 0.5 }}><Money satang={value} /></Box></Box>)}
  </Box>;
}

export default function Installments() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [list, setList] = useState<{ rows: InstallmentPlan[]; totals: InstallmentTotals } | null>(null);
  const [detail, setDetail] = useState<InstallmentDetail | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState<InstallmentDue | null>(null);
  const [payment, setPayment] = useState({ amount: '', paid_date: today(), bank_account_id: '' });
  const [reviewing, setReviewing] = useState<PlanItemPayment | null>(null);
  const [candidates, setCandidates] = useState<TxnListResponse['rows']>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: () => Promise<unknown> } | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true); setError(''); setDetail(null); setList(null);
    setEditor(false); setPaying(null); setReviewing(null); setConfirmation(null);
    const data = id ? req<InstallmentDetail>(`/api/installment-plans/${id}`) : req<{ rows: InstallmentPlan[]; totals: InstallmentTotals }>('/api/installment-plans');
    Promise.all([data, req<Account[]>('/api/accounts'), req<Category[]>('/api/categories')])
      .then(([result, banks, cats]) => { if (current) { if ('dues' in result) setDetail(result); else setList(result); setAccounts(banks); setCategories(cats); } })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [id, revision]);

  useEffect(() => {
    if (!reviewing) return;
    let current = true;
    const date = new Date(`${reviewing.paid_date}T00:00:00Z`);
    const start = new Date(date); start.setUTCDate(start.getUTCDate() - 3);
    const end = new Date(date); end.setUTCDate(end.getUTCDate() + 3);
    const query = new URLSearchParams({ bank_account_id: String(reviewing.bank_account_id), direction: 'debit', from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), min_satang: String(reviewing.amount_satang), max_satang: String(reviewing.amount_satang), limit: '200' });
    setCandidates([]); setCandidateLoading(true); setFormError('');
    req<TxnListResponse>(`/api/transactions?${query}`).then((data) => { if (current) setCandidates(data.rows.filter((t) => t.amount_satang === reviewing.amount_satang)); }).catch((e: Error) => { if (current) setFormError(e.message); }).finally(() => { if (current) setCandidateLoading(false); });
    return () => { current = false; };
  }, [reviewing]);

  const refresh = () => setRevision((n) => n + 1);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFormError('');
    try { await action(); refresh(); }
    catch (e) { setFormError(e instanceof Error ? e.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  const openEditor = () => {
    setFormError(''); setEditor(true);
    setForm(detail ? {
      name: detail.name, total_amount_satang: formatBaht(detail.total_amount_satang), down_payment_satang: formatBaht(detail.down_payment_satang), interest_satang: formatBaht(detail.interest_satang), fee_satang: formatBaht(detail.fee_satang),
      installment_count: String(detail.installment_count), frequency_unit: detail.frequency_unit, frequency_interval: String(detail.frequency_interval), first_due_date: detail.first_due_date, down_payment_date: detail.down_payment_date ?? '',
      default_account_id: detail.default_account_id == null ? '' : String(detail.default_account_id), category_id: detail.category_id == null ? '' : String(detail.category_id),
    } : emptyForm());
  };
  const structureLocked = detail != null && !detail.structural_editable;
  const save = async () => {
    setBusy(true); setFormError('');
    try {
      const metadata = { name: form.name, default_account_id: form.default_account_id ? Number(form.default_account_id) : null, category_id: form.category_id ? Number(form.category_id) : null };
      const body = structureLocked ? metadata : { ...metadata, total_amount_satang: readAmount(form.total_amount_satang), down_payment_satang: readAmount(form.down_payment_satang), interest_satang: readAmount(form.interest_satang), fee_satang: readAmount(form.fee_satang), installment_count: Number(form.installment_count), frequency_unit: form.frequency_unit, frequency_interval: Number(form.frequency_interval), first_due_date: form.first_due_date, down_payment_date: form.down_payment_date || null };
      if (detail) { await patch(`/api/installment-plans/${detail.id}`, body); refresh(); }
      else { const created = await post<{ id: number }>('/api/installment-plans', body); navigate(`/installments/${created.id}`); }
    } catch (e) { setFormError(e instanceof Error ? e.message : 'บันทึกแผนผ่อนไม่สำเร็จ'); }
    finally { setBusy(false); }
  };
  let payable: number | null = null;
  let financed: number | null = null;
  try { payable = readAmount(form.total_amount_satang) + readAmount(form.interest_satang) + readAmount(form.fee_satang); financed = readAmount(form.total_amount_satang) - readAmount(form.down_payment_satang); } catch { /* incomplete form */ }
  const liveDue = detail?.dues.find((d) => d.id === paying?.id) ?? paying;

  return <Stack spacing={2}>
    <Button component={Link} to={id ? '/installments' : '/planning'} sx={{ alignSelf: 'flex-start' }}>← {id ? 'แผนผ่อนทั้งหมด' : 'แผนรายเดือน'}</Button>
    <PageHeader level={1} id="installments-heading" title={detail?.name ?? (id ? 'รายละเอียดแผนผ่อน' : 'แผนผ่อนและยอดคงเหลือ')} description="ยอดจ่ายแล้วรวมรายการที่รอ Statement ยืนยันด้วย ข้อมูลเงินจริงไม่รวมเงินสดและ e-Wallet" action={<Button variant="contained" startIcon={<AddRounded />} disabled={loading || Boolean(error) || detail?.status === 'cancelled'} onClick={openEditor}>{id ? 'แก้ไขแผนผ่อน' : 'เพิ่มแผนผ่อน'}</Button>} />
    {error && <LoadError message={error} onRetry={refresh} />}
    {loading ? <TableSkeleton rows={5} /> : detail ? <>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}><Chip label={STATUS[detail.status]} variant="outlined" />{detail.status === 'active' && <Button color="error" onClick={() => { setFormError(''); setConfirmation({ title: 'ยกเลิกแผนผ่อน', description: 'เก็บประวัติและยอดเดิมไว้ แต่แยกออกจากยอดรวมแผนที่กำลังผ่อน การยกเลิกไม่ได้หมายถึงชำระหนี้แล้ว', action: () => patch(`/api/installment-plans/${detail.id}`, { status: 'cancelled' }) }); }}>ยกเลิกแผน</Button>}</Stack>
      <Typography variant="body2">ราคาซื้อ <Money satang={detail.total_amount_satang} /> · ดาวน์ <Money satang={detail.down_payment_satang} /> · เงินต้นผ่อน <Money satang={detail.financed_amount_satang} /> · ดอกเบี้ย <Money satang={detail.interest_satang} /> · ค่าธรรมเนียม <Money satang={detail.fee_satang} /></Typography>
      <Totals totals={detail} />
      <TableContainer component={Paper} variant="outlined" tabIndex={0}><Table size="small" aria-label="ตารางงวดผ่อน" sx={{ minWidth: 800 }}>
        <TableHead><TableRow><TableCell>งวด</TableCell><TableCell>ครบกำหนด</TableCell><TableCell align="right">ต้องชำระ</TableCell><TableCell align="right">จ่ายแล้ว</TableCell><TableCell align="right">ยืนยันแล้ว</TableCell><TableCell align="right">คงเหลือ</TableCell><TableCell>สถานะ</TableCell><TableCell>จัดการ</TableCell></TableRow></TableHead>
        <TableBody>{detail.dues.map((due) => <TableRow key={due.id}>
          <TableCell>{due.installment_no === 0 ? 'เงินดาวน์' : due.installment_no}</TableCell><TableCell>{formatDate(due.due_date)}</TableCell>
          <TableCell align="right"><Money satang={due.amount_satang} /></TableCell><TableCell align="right"><Money satang={due.paid_satang} /></TableCell><TableCell align="right"><Money satang={due.outstanding_satang} /></TableCell>
          <TableCell><Chip size="small" variant="outlined" color={due.status === 'overdue' ? 'error' : due.status === 'paid' ? 'success' : 'default'} label={DUE_STATUS[due.status]} />{due.plan_closed && <Typography variant="body2" color="text.secondary">เดือนปิดแล้ว</Typography>}</TableCell>
          <TableCell><Stack direction="row" spacing={0.5}>
            <Button onClick={() => { setFormError(''); setPaying(due); setPayment({ amount: formatBaht(due.outstanding_satang), paid_date: today(), bank_account_id: detail.default_account_id == null ? '' : String(detail.default_account_id) }); }}>การชำระ</Button>
            <Button disabled={busy || due.plan_closed || detail.status !== 'active' || due.paid_satang > 0} onClick={() => { setFormError(''); setConfirmation({ title: due.status === 'skipped' ? 'นำงวดกลับเข้าแผน' : 'ข้ามงวดนี้', description: 'การข้ามงวดไม่ลดหนี้คงเหลือและไม่ถือว่าชำระแล้ว', action: () => post(`/api/installment-dues/${due.id}/${due.status === 'skipped' ? 'restore' : 'skip'}`, {}) }); }}>{due.status === 'skipped' ? 'นำกลับ' : 'ข้าม'}</Button>
          </Stack></TableCell>
        </TableRow>)}</TableBody>
      </Table></TableContainer>
    </> : list && <>
      <Typography color="text.secondary">ยอดรวมเฉพาะแผนที่กำลังผ่อน</Typography><Totals totals={list.totals} />
      {list.rows.length === 0 ? <EmptyState icon={<EventRepeatRounded />} title="ยังไม่มีแผนผ่อน" description="เพิ่มราคาซื้อ เงินดาวน์ และจำนวนงวด เพื่อเห็นภาระทั้งหมดและติดตามยอดจ่าย" action={<Button variant="contained" onClick={openEditor}>เพิ่มแผนผ่อนแรก</Button>} /> : <TableContainer component={Paper} variant="outlined" tabIndex={0} data-tour="installments-table"><Table size="small" aria-label="แผนผ่อนทั้งหมด" sx={{ minWidth: 650 }}>
        <TableHead><TableRow><TableCell>แผนผ่อน</TableCell><TableCell>สถานะ</TableCell><TableCell align="right">ทั้งหมด</TableCell><TableCell align="right">จ่ายแล้ว</TableCell><TableCell align="right">คงเหลือ</TableCell></TableRow></TableHead>
        <TableBody>{list.rows.map((plan) => <TableRow key={plan.id}><TableCell><Button component={Link} to={`/installments/${plan.id}`}>{plan.name}</Button></TableCell><TableCell>{STATUS[plan.status]}</TableCell><TableCell align="right"><Money satang={plan.total_payable_satang} /></TableCell><TableCell align="right"><Money satang={plan.paid_satang} /></TableCell><TableCell align="right"><Money satang={plan.outstanding_satang} /></TableCell></TableRow>)}</TableBody>
      </Table></TableContainer>}
    </>}
    <Modal open={editor} title={detail ? 'แก้ไขแผนผ่อน' : 'เพิ่มแผนผ่อน'} onClose={() => setEditor(false)} busy={busy}>
      <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <TextField label="ชื่อแผนผ่อน" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {structureLocked && <Alert severity="info">แผนนี้มีประวัติชำระหรือเดือนปิดแล้ว จึงแก้ได้เฉพาะชื่อ หมวด และบัญชี</Alert>}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
          {(Object.entries(MONEY_FIELDS) as [MoneyField, string][]).map(([key, label]) => <TextField key={key} label={label} required disabled={structureLocked} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />)}
        </Box>
        {payable != null && financed != null && <Typography aria-live="polite">เงินต้นผ่อน <Money satang={financed} /> · ต้องชำระรวมดาวน์ <Money satang={payable} /></Typography>}
        <TextField label="วันครบกำหนดเงินดาวน์" type="date" disabled={structureLocked} value={form.down_payment_date} required={(parseBahtToSatang(form.down_payment_satang) ?? 0) > 0} onChange={(e) => setForm({ ...form, down_payment_date: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField label="จำนวนงวด (ไม่รวมดาวน์)" type="number" required disabled={structureLocked} value={form.installment_count} onChange={(e) => setForm({ ...form, installment_count: e.target.value })} slotProps={{ htmlInput: { min: 1, step: 1 } }} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}><TextField fullWidth label="ทุกกี่รอบ" type="number" required disabled={structureLocked} value={form.frequency_interval} onChange={(e) => setForm({ ...form, frequency_interval: e.target.value })} slotProps={{ htmlInput: { min: 1, step: 1 } }} /><TextField fullWidth select label="หน่วยรอบ" disabled={structureLocked} value={form.frequency_unit} onChange={(e) => setForm({ ...form, frequency_unit: e.target.value as Form['frequency_unit'] })}><MenuItem value="day">วัน</MenuItem><MenuItem value="month">เดือน</MenuItem><MenuItem value="year">ปี</MenuItem></TextField></Stack>
        <TextField label="วันครบกำหนดงวดแรก" type="date" required disabled={structureLocked} value={form.first_due_date} onChange={(e) => setForm({ ...form, first_due_date: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
        <TextField select label="บัญชีที่ใช้จ่าย" value={form.default_account_id} onChange={(e) => setForm({ ...form, default_account_id: e.target.value })}><MenuItem value="">เลือกตอนชำระ</MenuItem>{accounts.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.nickname}</MenuItem>)}</TextField>
        <TextField select label="หมวดรายจ่าย" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}><MenuItem value="">ยังไม่ระบุ</MenuItem>{categories.filter((c) => c.kind === 'expense' && c.is_active).map((c) => <MenuItem key={c.id} value={String(c.id)}>{c.name}</MenuItem>)}</TextField>
        <Typography variant="body2" color="text.secondary">งวดสุดท้ายรับเศษสตางค์จากการหาร จ่ายล่วงหน้าได้ทีละงวด ดอกเบี้ยและค่าธรรมเนียมใช้ยอดรวมที่กรอก</Typography>
        {formError && <Alert severity="error">{formError}</Alert>}<Button type="submit" variant="contained" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกแผนผ่อน'}</Button>
      </Stack>
    </Modal>
    <Modal open={paying != null} title={paying?.installment_no === 0 ? 'ชำระเงินดาวน์' : `การชำระงวด ${paying?.installment_no ?? ''}`} onClose={() => setPaying(null)} busy={busy}>
      <Stack spacing={2}>
        {liveDue && <Typography>ครบกำหนด {formatDate(liveDue.due_date)} · คงเหลือ <Money satang={liveDue.outstanding_satang} /></Typography>}
        {liveDue?.payments.map((p) => <Box key={p.id} sx={{ borderBottom: 1, borderColor: 'divider', pb: 1.5 }}><Typography>{formatDate(p.paid_date)} · <Money satang={p.amount_satang} /> · {PAYMENT_STATUS[p.status]}</Typography><Stack direction="row" spacing={1}>
          {p.status !== 'cancelled' && <Button color="error" disabled={busy || liveDue.plan_closed} onClick={() => { setPaying(null); setFormError(''); setConfirmation({ title: 'ยกเลิกการชำระ', description: 'ยอดชำระนี้จะถูกนำออกจากยอดจ่ายแล้ว และคืนเป็นยอดคงเหลือ', action: () => patch(`/api/monthly-item-payments/${p.id}`, { status: 'cancelled' }) }); }}>ยกเลิกการชำระ</Button>}
        </Stack></Box>)}
        {liveDue && liveDue.outstanding_satang > 0 && detail?.status === 'active' && liveDue.status !== 'skipped' && !liveDue.plan_closed && <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void run(async () => post(`/api/installment-dues/${liveDue.id}/payments`, { amount_satang: readAmount(payment.amount), paid_date: payment.paid_date, bank_account_id: Number(payment.bank_account_id) })); }}>
          <TextField label="ยอดชำระ (บาท)" required value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
          <TextField label="วันที่จ่ายจริง" type="date" required value={payment.paid_date} onChange={(e) => setPayment({ ...payment, paid_date: e.target.value })} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField select label="บัญชีที่จ่าย" required value={payment.bank_account_id} onChange={(e) => setPayment({ ...payment, bank_account_id: e.target.value })}>{accounts.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.nickname}</MenuItem>)}</TextField>
          <Typography variant="body2" color="text.secondary">บันทึกการจ่ายเต็มหรือบางส่วนก่อนวันครบกำหนดได้ ระบบจะรอ Statement ยืนยัน</Typography>
          <Button type="submit" variant="contained" disabled={busy}>{busy ? 'กำลังบันทึก…' : 'บันทึกว่าจ่ายแล้ว'}</Button>
        </Stack>}
        {liveDue?.plan_closed && <Alert severity="info">เดือนของงวดนี้ปิดแล้ว ต้องเปิดเดือนก่อนจึงเพิ่มหรือยกเลิกการชำระได้</Alert>}
        {formError && <Alert severity="error">{formError}</Alert>}
      </Stack>
    </Modal>
    <Modal open={reviewing != null} title="เลือกคู่ Statement" onClose={() => setReviewing(null)} busy={busy}><Stack spacing={2}>
      {candidateLoading ? <TableSkeleton rows={2} /> : candidates.length === 0 ? <Typography>ยังไม่มีธุรกรรมที่ตรงกับยอดและวันที่ชำระ</Typography> : candidates.map((c) => <Paper key={c.id} variant="outlined" sx={{ p: 2 }}><Stack spacing={1}><Typography>{formatDate(c.txn_date)} · {c.description}</Typography><Money satang={c.amount_satang} /><Button disabled={busy} onClick={() => void run(() => patch(`/api/monthly-item-payments/${reviewing!.id}`, { txn_id: c.id }))}>ยืนยันคู่นี้</Button></Stack></Paper>)}
      {formError && <Alert severity="error">{formError}</Alert>}
    </Stack></Modal>
    <ConfirmDialog open={confirmation != null} title={confirmation?.title ?? ''} description={`${confirmation?.description ?? ''}${formError ? ` — ${formError}` : ''}`} confirmLabel="ยืนยัน" busy={busy} onClose={() => setConfirmation(null)} onConfirm={() => { if (confirmation) void run(confirmation.action); }} />
  </Stack>;
}
