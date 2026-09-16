import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormLabel,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import ReplayRounded from '@mui/icons-material/ReplayRounded';
import LockOutlined from '@mui/icons-material/LockOutlined';
import LockOpenOutlined from '@mui/icons-material/LockOpenOutlined';
import PaidRounded from '@mui/icons-material/PaidRounded';
import SkipNextRounded from '@mui/icons-material/SkipNextRounded';
import {
  del,
  patch,
  post,
  req,
  type Account,
  type Category,
  type MonthlyPlan as Plan,
  type PlanItem,
  type PlanItemPayment,
  type PlanKind,
  type RecurringRule,
} from '../api.js';
import Modal from '../Modal.js';
import Money from '../components/Money.js';
import MonthPicker, { currentMonth, shiftMonth } from '../components/MonthPicker.js';
import PaymentStatusChip from '../components/PaymentStatusChip.js';
import IncomeSection from '../components/IncomeSection.js';
import SummaryCard from '../components/SummaryCard.js';
import { createFormFieldChangeHandler } from '../form.js';
import { formatDate, parseBahtToSatang } from '../format.js';
import { dataTextSx, descriptionSx } from '../theme.js';
import { ConfirmDialog, EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from '../ui.js';


// API จำกัดการวางแผนล่วงหน้าไว้ 12 เดือน (MAX_MONTHS_AHEAD ใน src/routes/monthly-plans.ts)
const MAX_MONTH = shiftMonth(currentMonth(), 12);

const KINDS: { value: PlanKind; label: string }[] = [
  { value: 'income', label: 'รายได้' },
  { value: 'payroll_deduction', label: 'รายการหักจากรายได้' },
  { value: 'expense', label: 'รายจ่าย' },
  { value: 'reserve', label: 'เงินกันไว้' },
];
const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.value, k.label])) as Record<PlanKind, string>;
const UNITS = [
  { value: 'day', label: 'วัน' },
  { value: 'week', label: 'สัปดาห์' },
  { value: 'month', label: 'เดือน' },
  { value: 'year', label: 'ปี' },
] as const;

const EMPTY_ITEM = { kind: 'expense', name: '', amount_baht: '', due_date: '', category_id: '', note: '' };
const EMPTY_RULE = {
  name: '',
  kind: 'expense',
  amount_mode: 'fixed',
  amount_baht: '',
  frequency_unit: 'month',
  frequency_interval: '1',
  anchor_day: '',
  start_date: '',
  end_date: '',
  default_account_id: '',
  category_id: '',
};
const EMPTY_PAYMENT = { amount_baht: '', paid_date: '', bank_account_id: '' };

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

export default function MonthlyPlan() {
  const [searchParams, setSearchParams] = useSearchParams();
  const month = searchParams.get('month') ?? currentMonth();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const requestIdRef = useRef(0);

  const [itemForm, setItemForm] = useState(EMPTY_ITEM);
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const setItemField = createFormFieldChangeHandler(setItemForm);

  const [ruleForm, setRuleForm] = useState(EMPTY_RULE);
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const setRuleField = createFormFieldChangeHandler(setRuleForm);

  const [payingItem, setPayingItem] = useState<PlanItem | null>(null);
  const [paymentForm, setPaymentForm] = useState(EMPTY_PAYMENT);
  const setPaymentField = createFormFieldChangeHandler(setPaymentForm);

  const [archivingRule, setArchivingRule] = useState<RecurringRule | null>(null);
  // ปุ่มต้นทางของ dialog บางตัวหายไปหลังทำสำเร็จ ("ปิดเดือนนี้" ถูกแทนด้วยปุ่มเปิดเดือน, "เลือกคู่"
  // หายเมื่อ payment ไม่ needs_review แล้ว) MUI คืน focus ให้เฉพาะเมื่อ element เดิมยังอยู่ —
  // ไม่งั้น focus ตกไปที่ body ใช้ปุ่มที่อยู่ถาวรบนหน้าเป็นที่รับ focus แทน (ท่าเดียวกับ Accounts.tsx)
  const addItemButtonRef = useRef<HTMLButtonElement>(null);

  const setMonth = (next: string) =>
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set('month', next);
      return params;
    });

  // requestIdRef กัน response ที่มาไม่เรียงลำดับ (สลับเดือนเร็ว ๆ) เขียนทับผลของคำขอล่าสุด
  const reload = async (background = false) => {
    const requestId = ++requestIdRef.current;
    if (!background) setLoading(true);
    setError('');
    const [planResult, rulesResult] = await Promise.allSettled([
      req<Plan>(`/api/monthly-plans/${month}`),
      req<RecurringRule[]>('/api/recurring-rules'),
    ]);
    if (requestId !== requestIdRef.current) return;
    const failures: string[] = [];
    if (planResult.status === 'fulfilled') setPlan(planResult.value);
    else {
      failures.push(errorMessage(planResult.reason, 'โหลดแผนรายเดือนไม่สำเร็จ'));
      if (!background) setPlan(null);
    }
    if (rulesResult.status === 'fulfilled') setRules(rulesResult.value);
    else failures.push(errorMessage(rulesResult.reason, 'โหลดรายการประจำไม่สำเร็จ'));
    setError(failures.join(' • '));
    setLoading(false);
  };

  useEffect(() => {
    void (async () => {
      const [accountsResult, categoriesResult] = await Promise.allSettled([
        req<Account[]>('/api/accounts'),
        req<Category[]>('/api/categories?is_active=true'),
      ]);
      if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
      if (categoriesResult.status === 'fulfilled') setCategories(categoriesResult.value);
    })();
  }, []);

  useEffect(() => {
    void reload(false);
  }, [month]);

  const closed = plan?.status === 'closed';
  const items = plan?.items ?? [];
  const activeRules = rules.filter((r) => r.is_active);

  // ปุ่มบนแถบเครื่องมือ (คัดลอกเดือนก่อน / ปิด-เปิดเดือน / ข้าม / เลิกใช้) ไม่มี Alert ของ formError
  // ให้แสดง ถ้าโยน error ลง formError ตัวเดียวเสมอ ความล้มเหลวของปุ่มเหล่านั้นจะเงียบหายไปทั้งหมด —
  // มี modal เปิดอยู่ค่อยแสดงในฟอร์ม (อยู่ติดกับสิ่งที่ผู้ใช้กรอกผิด) ไม่มีก็ส่งเข้า snackbar
  const run = async (action: () => Promise<unknown>, successMessage: string, onDone?: () => void) => {
    // ConfirmDialog (closing / archivingRule) ไม่มีช่องแสดง error ในตัว จึงไม่นับเป็น "อยู่ในฟอร์ม"
    const inModal = itemModalOpen || ruleModalOpen || payingItem != null;
    setFormError('');
    setSubmitting(true);
    try {
      await action();
      setNotice({ message: successMessage, severity: 'success' });
      onDone?.();
      await reload(true);
    } catch (e) {
      const message = errorMessage(e, 'บันทึกไม่สำเร็จ');
      if (inModal) setFormError(message);
      else setNotice({ message, severity: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  const openAddItem = () => {
    setEditingItemId(null);
    setItemForm({ ...EMPTY_ITEM, due_date: '' });
    setFormError('');
    setItemModalOpen(true);
  };

  const openEditItem = (item: PlanItem) => {
    setEditingItemId(item.id);
    setItemForm({
      kind: item.kind,
      name: item.name,
      amount_baht: (item.planned_amount_satang / 100).toFixed(2),
      due_date: item.due_date ?? '',
      category_id: item.category_id == null ? '' : String(item.category_id),
      note: item.note ?? '',
    });
    setFormError('');
    setItemModalOpen(true);
  };

  const submitItem = () => {
    const satang = parseBahtToSatang(itemForm.amount_baht);
    if (satang == null) {
      setFormError('จำนวนเงินไม่ถูกต้อง');
      return;
    }
    const body: Record<string, unknown> = {
      name: itemForm.name,
      planned_amount_satang: satang,
      due_date: itemForm.due_date === '' ? null : itemForm.due_date,
      category_id: itemForm.category_id === '' ? null : Number(itemForm.category_id),
      note: itemForm.note === '' ? null : itemForm.note,
    };
    // kind เปลี่ยนหลังสร้างไม่ได้ (รายจ่ายกับเงินกันไว้คนละความหมายในสูตร §8.2) — ส่งเฉพาะตอนสร้างใหม่
    if (editingItemId == null) body.kind = itemForm.kind;
    void run(
      () =>
        editingItemId == null
          ? post(`/api/monthly-plans/${month}/items`, body)
          : patch(`/api/monthly-plan-items/${editingItemId}`, body),
      editingItemId == null ? 'เพิ่มรายการในแผนแล้ว' : 'บันทึกการแก้ไขแล้ว',
      () => setItemModalOpen(false),
    );
  };

  const openAddRule = () => {
    setEditingRuleId(null);
    setRuleForm({ ...EMPTY_RULE, start_date: `${month}-01` });
    setFormError('');
    setRuleModalOpen(true);
  };

  const openEditRule = (rule: RecurringRule) => {
    setEditingRuleId(rule.id);
    setRuleForm({
      name: rule.name,
      kind: rule.kind,
      amount_mode: rule.amount_mode,
      amount_baht: (rule.amount_satang / 100).toFixed(2),
      frequency_unit: rule.frequency_unit,
      frequency_interval: String(rule.frequency_interval),
      anchor_day: rule.anchor_day == null ? '' : String(rule.anchor_day),
      start_date: rule.start_date,
      end_date: rule.end_date ?? '',
      default_account_id: rule.default_account_id == null ? '' : String(rule.default_account_id),
      category_id: rule.category_id == null ? '' : String(rule.category_id),
    });
    setFormError('');
    setRuleModalOpen(true);
  };

  const submitRule = () => {
    const satang = parseBahtToSatang(ruleForm.amount_baht);
    if (satang == null) {
      setFormError('จำนวนเงินไม่ถูกต้อง');
      return;
    }
    // Number('x') เป็น NaN แล้ว JSON.stringify แปลงเป็น null ทำให้ฝั่ง server coalesce เป็น "ทุก 1"
    // และล้าง anchor_day เงียบ ๆ — ต้องดักที่นี่ให้ผู้ใช้เห็นว่ากรอกอะไรผิด
    const interval = Number(ruleForm.frequency_interval);
    if (!Number.isInteger(interval) || interval < 1 || interval > 366) {
      setFormError('ความถี่ต้องเป็นจำนวนเต็ม 1–366');
      return;
    }
    const anchorDay = ruleForm.anchor_day === '' ? null : Number(ruleForm.anchor_day);
    if (anchorDay != null && (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)) {
      setFormError('วันครบกำหนดต้องเป็นจำนวนเต็ม 1–31');
      return;
    }
    const body: Record<string, unknown> = {
      name: ruleForm.name,
      kind: ruleForm.kind,
      amount_mode: ruleForm.amount_mode,
      amount_satang: satang,
      frequency_unit: ruleForm.frequency_unit,
      frequency_interval: interval,
      anchor_day: anchorDay,
      start_date: ruleForm.start_date,
      end_date: ruleForm.end_date === '' ? null : ruleForm.end_date,
      default_account_id: ruleForm.default_account_id === '' ? null : Number(ruleForm.default_account_id),
      category_id: ruleForm.category_id === '' ? null : Number(ruleForm.category_id),
    };
    void run(
      () =>
        editingRuleId == null
          ? post('/api/recurring-rules', body)
          : patch(`/api/recurring-rules/${editingRuleId}`, body),
      editingRuleId == null ? 'เพิ่มรายการประจำแล้ว' : 'บันทึกรายการประจำแล้ว — มีผลกับเดือนที่ยังไม่สร้างรายการ',
      () => setRuleModalOpen(false),
    );
  };

  // เติมค่าเริ่มต้นให้ครบที่สุดที่รู้: ยอดคงเหลือที่ยังไม่จ่าย, วันครบกำหนด และ "บัญชีที่คาดว่าจะใช้"
  // ของรายการประจำต้นทาง (§9.2) — ถ้าไม่อ่านค่านั้นที่นี่ ช่องนั้นในฟอร์มกฎก็ไม่มีใครใช้เลย
  //
  // ยกเว้นยอด: รายการยอดประมาณการปล่อยช่องว่างให้พิมพ์ยอดจากบิลจริง — reconcile เทียบยอดเป๊ะถึงสตางค์
  // (`t.amount_satang = p.amount_satang`) เติมยอดที่เดาไว้ให้แล้วผู้ใช้กดผ่าน = ประกาศจ่าย 4,000
  // ที่ไม่มี txn ไหนตรง ค้างรอ statement ถาวร ขณะที่เงินออกจริง 3,800 ลอยไม่ถูกจับคู่
  const openPayment = (item: PlanItem) => {
    const remaining = Math.max(0, item.planned_amount_satang - item.paid_satang);
    const rule = item.recurring_rule_id == null ? undefined : rules.find((r) => r.id === item.recurring_rule_id);
    const defaultAccountId = rule?.default_account_id ?? accounts[0]?.id ?? null;
    setPayingItem(item);
    setPaymentForm({
      amount_baht:
        item.amount_mode === 'estimated'
          ? ''
          : ((remaining > 0 ? remaining : item.planned_amount_satang) / 100).toFixed(2),
      paid_date: item.due_date ?? `${month}-01`,
      bank_account_id: defaultAccountId == null ? '' : String(defaultAccountId),
    });
    setFormError('');
  };

  const submitPayment = () => {
    if (!payingItem) return;
    const satang = parseBahtToSatang(paymentForm.amount_baht);
    if (satang == null || satang <= 0) {
      setFormError('จำนวนเงินไม่ถูกต้อง');
      return;
    }
    void run(
      () =>
        post(`/api/monthly-plan-items/${payingItem.id}/payments`, {
          amount_satang: satang,
          paid_date: paymentForm.paid_date,
          bank_account_id: Number(paymentForm.bank_account_id),
        }),
      'บันทึกการจ่ายแล้ว',
      () => setPayingItem(null),
    );
  };

  const summary = plan?.payment_status;
  // payingItem เป็น snapshot ตอนกดปุ่ม — หลัง reload ต้องอ่านของจริงจาก plan ไม่งั้นรายการจ่าย
  // ที่เพิ่งบันทึกหรือเพิ่งยกเลิกจะไม่อัปเดตในกล่องที่ยังเปิดอยู่
  const payingItemLive = payingItem == null ? null : items.find((i) => i.id === payingItem.id) ?? payingItem;

  return (
    <Box>
      <PageHeader
        level={1}
        id="planning-heading"
        title="วางแผนรายเดือน"
        description="รายการประจำ รายการเฉพาะเดือน และการยืนยันการจ่ายกับ statement จริง"
        action={
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button
              variant="outlined"
              startIcon={<ContentCopyRounded />}
              disabled={closed || submitting || loading}
              onClick={() => void run(() => post(`/api/monthly-plans/${month}/copy-previous`, {}), 'คัดลอกจากเดือนก่อนแล้ว')}
            >
              คัดลอกเดือนก่อน
            </Button>
            <Button
              ref={addItemButtonRef}
              variant="contained"
              startIcon={<AddRounded />}
              disabled={closed || loading}
              onClick={openAddItem}
            >
              เพิ่มรายการ
            </Button>
          </Stack>
        }
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {plan?.data_coverage_note ??
          'ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น ไม่รวมเงินสดและ e-Wallet'}
      </Typography>

      <Stack direction="row" spacing={1.5} sx={{ mt: 3, alignItems: 'center', flexWrap: 'wrap' }}>
        <MonthPicker value={month} onChange={setMonth} maxMonth={MAX_MONTH} />
        <Button component={Link} to="/installments" variant="outlined">แผนผ่อนและยอดคงเหลือ</Button>
        {/* ระหว่างสลับเดือน `closed` ยังเป็นค่าของเดือนก่อน และถ้าโหลดพลาด (plan == null) ก็ไม่รู้สถานะ
            เลย — ปุ่มล็อกจึงต้องรอให้ plan ของเดือนนี้มาถึงก่อน ไม่งั้นกดปิด/เปิดใส่เดือนผิดได้ */}
        {plan != null && !loading && (
          closed ? (
            <Button
              variant="outlined"
              startIcon={<LockOpenOutlined />}
              disabled={submitting}
              onClick={() => void run(() => post(`/api/monthly-plans/${month}/reopen`, {}), 'เปิดเดือนนี้ให้แก้ได้แล้ว')}
            >
              เปิดเดือนนี้อีกครั้ง
            </Button>
          ) : (
            <Button
              variant="outlined"
              startIcon={<LockOutlined />}
              disabled={submitting}
              onClick={() => setClosing(true)}
            >
              ปิดเดือนนี้
            </Button>
          )
        )}
      </Stack>

      {closed && !loading && (
        <Alert severity="info" sx={{ mt: 2, ...descriptionSx }}>
          เดือนนี้ปิดแล้ว แก้รายการไม่ได้จนกดเปิดอีกครั้ง — statement ที่มาถึงภายหลังยังจับคู่กับรายการที่ประกาศจ่ายไว้ได้
          ตัวเลขด้านล่างคำนวณสดจากข้อมูลล่าสุดเสมอ ไม่ใช่ภาพนิ่งตอนปิดเดือน
        </Alert>
      )}

      {error && <LoadError message={error} onRetry={plan == null ? () => void reload() : undefined} />}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : plan == null ? null : (
        <Stack spacing={4} sx={{ mt: 3 }}>
          <Box component="section" aria-labelledby="plan-totals-heading">
            <Typography variant="h2" id="plan-totals-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>
              สรุปตามแผน
            </Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <SummaryCard title="รายได้เต็มตามแผน" value={<Money satang={plan.totals.planned_income_satang} tone="income" />} />
              <SummaryCard title="รายการหักจากรายได้" value={<Money satang={plan.totals.planned_deduction_satang} />} />
              <SummaryCard title="ค่าใช้จ่ายตามแผน" value={<Money satang={plan.totals.planned_expense_satang} tone="expense" />} />
              <SummaryCard
                title="เงินกันไว้"
                value={<Money satang={plan.totals.planned_reserve_satang} />}
                caption="กันงบไว้ ไม่ใช่รายจ่าย และไม่ลดยอดคงเหลือในบัญชี"
              />
              <SummaryCard
                title="เงินเหลือใช้ตามแผน"
                value={
                  <Money
                    satang={plan.totals.planned_available_satang}
                    tone={plan.totals.planned_available_satang < 0 ? 'expense' : 'income'}
                  />
                }
                caption="รายได้เต็ม − รายการหัก − รายจ่ายตามแผน − เงินกันไว้"
              />
            </Box>
          </Box>

          {summary && summary.total_count > 0 && (
            <Box component="section" aria-labelledby="plan-payment-heading">
              <Typography variant="h2" id="plan-payment-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>
                สถานะการจ่ายบิล
              </Typography>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                  <Chip label={`ต้องจ่ายทั้งหมด ${summary.total_count}`} variant="outlined" />
                  <Chip label={`ยังไม่จ่าย ${summary.unpaid_count}`} variant="outlined" />
                  <Chip label={`เกินกำหนด ${summary.overdue_count}`} color={summary.overdue_count > 0 ? 'error' : 'default'} variant={summary.overdue_count > 0 ? 'filled' : 'outlined'} />
                  <Chip label={`จ่ายบางส่วน ${summary.partial_count}`} variant="outlined" />
                  <Chip label={`จ่ายแล้ว ${summary.paid_count}`} color={summary.paid_count > 0 ? 'success' : 'default'} variant={summary.paid_count > 0 ? 'filled' : 'outlined'} />
                </Stack>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                  จ่ายแล้ว <Money satang={summary.paid_satang} /> จากยอดตามแผน <Money satang={summary.total_due_satang} />
                </Typography>
              </Paper>
            </Box>
          )}

          <IncomeSection key={month} month={month} closed={closed} items={items} onChanged={() => reload(true)} />

          <Box component="section" aria-labelledby="plan-items-heading">
            <Typography variant="h2" id="plan-items-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>
              รายการของเดือนนี้
            </Typography>
            {items.length === 0 ? (
              <EmptyState
                icon={<EventRepeatRounded sx={{ fontSize: 40 }} />}
                title="ยังไม่มีรายการในแผนเดือนนี้"
                description="เพิ่มรายการเฉพาะเดือน คัดลอกจากเดือนก่อน หรือสร้างรายการประจำเพื่อให้ระบบสร้างให้ทุกเดือน"
                action={
                  <Button variant="contained" startIcon={<AddRounded />} disabled={closed} onClick={openAddItem}>
                    เพิ่มรายการแรก
                  </Button>
                }
              />
            ) : (
              <TableContainer component={Paper} variant="outlined" tabIndex={0}>
                <Table size="small" aria-label="รายการในแผนเดือนนี้" sx={{ minWidth: 900 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>ประเภท</TableCell>
                      <TableCell>รายการ</TableCell>
                      <TableCell>หมวด</TableCell>
                      <TableCell>ครบกำหนด</TableCell>
                      <TableCell align="right">ตามแผน</TableCell>
                      <TableCell align="right">จ่ายแล้ว</TableCell>
                      <TableCell>สถานะ</TableCell>
                      <TableCell align="right">จัดการ</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {items.map((item) => {
                      const inactive = item.explicit_status !== 'active';
                      return (
                        <TableRow key={item.id} hover>
                          <TableCell>{KIND_LABEL[item.kind]}</TableCell>
                          <TableCell>
                            {item.name}
                            {item.recurring_rule_id != null && (
                              <Chip size="small" label="ประจำ" variant="outlined" sx={{ ml: 1 }} />
                            )}
                          </TableCell>
                          <TableCell>{item.category_name ?? '—'}</TableCell>
                          <TableCell sx={dataTextSx}>{item.due_date ? formatDate(item.due_date) : '—'}</TableCell>
                          <TableCell align="right">
                            <Money satang={item.planned_amount_satang} />
                          </TableCell>
                          <TableCell align="right">
                            {item.paid_satang > 0 ? <Money satang={item.paid_satang} /> : '—'}
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                              <PaymentStatusChip state={item.payment_state} />
                              {/* ยอดประมาณการไม่มีสถานะ partial แล้ว สถานะจึงไม่บอกว่ายอดจริงต่าง
                                  จากที่เดาไว้เท่าไร ต้องโชว์ตรงนี้ — คิดสดจาก paid − planned ไม่มี
                                  field ใหม่จาก API ไม่ใส่สี เพราะสูง/ต่ำกว่าประมาณไม่ใช่ดี/ร้าย
                                  (เหตุผลเดียวกับ comment ใน PaymentStatusChip.tsx)

                                  ข้าม item ที่ผูก income_record: `planned_amount_satang` ของมันคือ
                                  ยอดเต็ม แต่ payment คือยอดสุทธิ ส่วนต่างจึงเป็นรายการหัก ไม่ใช่
                                  การประมาณคลาด — ยอดเต็ม/หัก/สุทธิ ดูได้ในตาราง "รายได้และรายการหัก" */}
                              {item.amount_mode === 'estimated' &&
                                item.income_record_id == null &&
                                item.paid_satang > 0 &&
                                item.paid_satang !== item.planned_amount_satang && (
                                  <Typography variant="caption" color="text.secondary">
                                    {item.paid_satang < item.planned_amount_satang
                                      ? 'ต่ำกว่าประมาณ '
                                      : 'สูงกว่าประมาณ '}
                                    <Money satang={item.paid_satang - item.planned_amount_satang} />
                                  </Typography>
                                )}
                            </Stack>
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                              {/* "จ่ายแล้ว" เป็นปุ่มของรายจ่าย/เงินกันไว้เท่านั้น — เงินเข้าต้องบันทึกที่
                                  "รายได้และรายการหัก" เพื่อแยกยอดเต็มออกจากยอดสุทธิ (ADR-0002 ข้อ 5)
                                  เดิมปุ่มนี้กดบนรายการรายได้ได้ แล้วประกาศจ่ายยอดสุทธิที่เข้าบัญชีจริง
                                  (26,125) ไปเทียบกับยอดเต็มตามแผน (27,000) → ค้าง "จ่ายบางส่วน"
                                  รายการหักจากเงินเดือนไม่มีปุ่มอะไรเลย เงินไม่ได้ออกจากบัญชีเรา
                                  มันขึ้น "หักจากรายได้" เองเมื่อถูกผูกจากฟอร์มรายได้

                                  เงื่อนไข `paid_satang === 0`: แถวที่ยังมีประกาศจ่ายค้างอยู่ต้องเหลือ
                                  ปุ่ม "จ่ายแล้ว" ไว้ เพราะปุ่มยกเลิกการประกาศจ่ายอยู่ใน modal นั้น
                                  ที่เดียว ถ้าสลับเป็น anchor ทั้งหมด จะยกเลิกของเก่าไม่ได้ และ
                                  dropdown ในฟอร์มรายได้ซ่อนรายการที่ยังมี payment อยู่ = ตัน
                                  ยกเลิกแล้ว paid_satang กลับเป็น 0 ปุ่มจะสลับเป็น anchor ให้เอง */}
                              {item.kind === 'income' && item.income_record_id == null && item.paid_satang === 0 ? (
                                <Button size="small" startIcon={<PaidRounded />} href="#income-heading" disabled={closed || inactive}>
                                  บันทึกรายได้เต็ม
                                </Button>
                              ) : item.kind === 'payroll_deduction' &&
                                item.income_record_id == null &&
                                item.paid_satang === 0 ? null : (
                                <Button
                                  size="small"
                                  startIcon={<PaidRounded />}
                                  disabled={closed || inactive || item.income_record_id != null || item.installment_due_id != null}
                                  onClick={() => openPayment(item)}
                                >
                                  จ่ายแล้ว
                                </Button>
                              )}
                              <Button
                                size="small"
                                startIcon={<EditRounded />}
                                disabled={closed || item.income_record_id != null || item.installment_due_id != null}
                                onClick={() => openEditItem(item)}
                              >
                                แก้ไข
                              </Button>
                              {inactive ? (
                                <Button
                                  size="small"
                                  color="inherit"
                                  startIcon={<ReplayRounded />}
                                  disabled={closed || item.income_record_id != null || item.installment_due_id != null}
                                  onClick={() =>
                                    void run(
                                      () => patch(`/api/monthly-plan-items/${item.id}`, { explicit_status: 'active' }),
                                      'เอารายการกลับเข้าแผนแล้ว',
                                    )
                                  }
                                >
                                  เอากลับเข้าแผน
                                </Button>
                              ) : (
                                <Button
                                  size="small"
                                  color="inherit"
                                  startIcon={<SkipNextRounded />}
                                  disabled={closed || item.income_record_id != null || item.installment_due_id != null}
                                  onClick={() =>
                                    void run(
                                      () => post(`/api/monthly-plan-items/${item.id}/skip`, {}),
                                      'ข้ามรายการนี้แล้ว',
                                    )
                                  }
                                >
                                  ข้าม
                                </Button>
                              )}
                              <Button
                                size="small"
                                color="error"
                                startIcon={<DeleteOutlineRounded />}
                                disabled={closed || item.income_record_id != null || item.installment_due_id != null}
                                onClick={() =>
                                  void run(
                                    () => del(`/api/monthly-plan-items/${item.id}`),
                                    'ลบรายการแล้ว',
                                  )
                                }
                              >
                                ลบ
                              </Button>
                              {item.income_record_id != null && <Typography variant="body2" color="text.secondary">จัดการในรายได้ด้านบน</Typography>}
                              {item.installment_due_id != null && <Button component={Link} to="/installments">ดูแผนผ่อน</Button>}
                            </Stack>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>

          <Box component="section" aria-labelledby="plan-rules-heading">
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
              <Typography variant="h2" id="plan-rules-heading" sx={{ fontSize: '1.25rem' }}>
                รายการประจำ
              </Typography>
              <Button variant="outlined" size="small" startIcon={<AddRounded />} onClick={openAddRule}>
                เพิ่มรายการประจำ
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, ...descriptionSx }}>
              ระบบสร้างรายการให้ทุกเดือนที่เปิดดู การแก้กฎมีผลกับเดือนที่ยังไม่ได้สร้างรายการเท่านั้น
              ไม่ย้อนแก้เดือนที่ตรวจหรือปิดไปแล้ว
            </Typography>
            {activeRules.length === 0 ? (
              <EmptyState
                icon={<EventRepeatRounded sx={{ fontSize: 40 }} />}
                title="ยังไม่มีรายการประจำ"
                description="เช่น ค่าเช่าบ้านทุกวันที่ 5 หรือเบี้ยประกันทุกปี — สร้างครั้งเดียวแล้วระบบสร้างรายการให้ทุกเดือน"
              />
            ) : (
              <TableContainer component={Paper} variant="outlined" tabIndex={0}>
                <Table size="small" aria-label="รายการประจำ" sx={{ minWidth: 780 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>ประเภท</TableCell>
                      <TableCell>ชื่อ</TableCell>
                      <TableCell>ความถี่</TableCell>
                      <TableCell>ช่วงที่ใช้</TableCell>
                      <TableCell align="right">ยอด</TableCell>
                      <TableCell align="right">จัดการ</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {activeRules.map((rule) => (
                      <TableRow key={rule.id} hover>
                        <TableCell>{KIND_LABEL[rule.kind]}</TableCell>
                        <TableCell>{rule.name}</TableCell>
                        <TableCell>
                          ทุก {rule.frequency_interval} {UNITS.find((u) => u.value === rule.frequency_unit)?.label}
                          {rule.anchor_day != null && ` (วันที่ ${rule.anchor_day})`}
                        </TableCell>
                        <TableCell sx={dataTextSx}>
                          {formatDate(rule.start_date)} – {rule.end_date ? formatDate(rule.end_date) : 'ไม่กำหนด'}
                        </TableCell>
                        <TableCell align="right">
                          <Money satang={rule.amount_satang} />
                          {rule.amount_mode === 'estimated' && (
                            <Chip size="small" label="ประมาณการ" variant="outlined" sx={{ ml: 1 }} />
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} sx={{ justifyContent: 'flex-end' }}>
                            <Button size="small" startIcon={<EditRounded />} onClick={() => openEditRule(rule)}>
                              แก้ไข
                            </Button>
                            {/* ไม่มี unarchive ใน API (ดู docs/status.md) ย้อนกลับจากหน้าจอไม่ได้ ต้องถามก่อน */}
                            <Button
                              size="small"
                              color="error"
                              startIcon={<ArchiveOutlined />}
                              onClick={() => setArchivingRule(rule)}
                            >
                              เลิกใช้
                            </Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </Stack>
      )}

      <Modal
        open={itemModalOpen}
        title={editingItemId == null ? 'เพิ่มรายการในแผน' : 'แก้ไขรายการในแผน'}
        onClose={() => setItemModalOpen(false)}
        busy={submitting}
      >
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            submitItem();
          }}
        >
          <Stack spacing={2.5}>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <TextField
                select
                label="ประเภท"
                value={itemForm.kind}
                onChange={setItemField('kind')}
                disabled={editingItemId != null}
                helperText={editingItemId == null ? 'เงินกันไว้ไม่นับเป็นรายจ่าย' : 'เปลี่ยนประเภทหลังสร้างไม่ได้'}
                required
              >
                {KINDS.map((k) => (
                  <MenuItem key={k.value} value={k.value}>
                    {k.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="ชื่อรายการ" value={itemForm.name} onChange={setItemField('name')} required slotProps={{ htmlInput: { maxLength: 120 } }} />
              <TextField
                label="จำนวนเงิน (บาท)"
                value={itemForm.amount_baht}
                onChange={setItemField('amount_baht')}
                required
                error={itemForm.amount_baht !== '' && parseBahtToSatang(itemForm.amount_baht) == null}
                helperText={itemForm.amount_baht !== '' && parseBahtToSatang(itemForm.amount_baht) == null ? 'กรอกเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง' : ' '}
                slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
              />
              <TextField
                type="date"
                label="ครบกำหนด (ไม่บังคับ)"
                value={itemForm.due_date}
                onChange={setItemField('due_date')}
                helperText="ต้องอยู่ในเดือนของแผนนี้"
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: `${month}-01`, sx: dataTextSx } }}
              />
              <TextField select label="หมวด (ไม่บังคับ)" value={itemForm.category_id} onChange={setItemField('category_id')}>
                <MenuItem value="">
                  <em>— ไม่ระบุ —</em>
                </MenuItem>
                {categories.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="บันทึกเพิ่มเติม" value={itemForm.note} onChange={setItemField('note')} slotProps={{ htmlInput: { maxLength: 500 } }} />
            </Box>
            {formError && <Alert severity="error">{formError}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setItemModalOpen(false)} disabled={submitting}>
                ยกเลิก
              </Button>
              <Button type="submit" variant="contained" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'กำลังบันทึก…' : 'บันทึก'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>

      <Modal
        open={ruleModalOpen}
        title={editingRuleId == null ? 'เพิ่มรายการประจำ' : 'แก้ไขรายการประจำ'}
        onClose={() => setRuleModalOpen(false)}
        busy={submitting}
      >
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            submitRule();
          }}
        >
          <Stack spacing={2.5}>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>
                รายการและยอด
              </FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
                <TextField select label="ประเภท" value={ruleForm.kind} onChange={setRuleField('kind')} required>
                  {KINDS.map((k) => (
                    <MenuItem key={k.value} value={k.value}>
                      {k.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField label="ชื่อรายการ" value={ruleForm.name} onChange={setRuleField('name')} required slotProps={{ htmlInput: { maxLength: 120 } }} />
                <TextField
                  label="จำนวนเงิน (บาท)"
                  value={ruleForm.amount_baht}
                  onChange={setRuleField('amount_baht')}
                  required
                  error={ruleForm.amount_baht !== '' && parseBahtToSatang(ruleForm.amount_baht) == null}
                  slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
                />
                <TextField select label="ชนิดยอด" value={ruleForm.amount_mode} onChange={setRuleField('amount_mode')}>
                  <MenuItem value="fixed">ยอดคงที่</MenuItem>
                  <MenuItem value="estimated">ยอดประมาณการ</MenuItem>
                </TextField>
              </Box>
            </Box>

            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>
                ความถี่
              </FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
                <TextField
                  label="ทุกกี่ครั้ง"
                  value={ruleForm.frequency_interval}
                  onChange={setRuleField('frequency_interval')}
                  required
                  slotProps={{ htmlInput: { inputMode: 'numeric', sx: dataTextSx } }}
                />
                <TextField select label="หน่วย" value={ruleForm.frequency_unit} onChange={setRuleField('frequency_unit')} required>
                  {UNITS.map((u) => (
                    <MenuItem key={u.value} value={u.value}>
                      {u.label}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  label="วันครบกำหนด (1–31)"
                  value={ruleForm.anchor_day}
                  onChange={setRuleField('anchor_day')}
                  disabled={ruleForm.frequency_unit === 'day' || ruleForm.frequency_unit === 'week'}
                  helperText="ตั้ง 29–31 ได้ เดือนที่ไม่มีวันนั้นจะใช้วันสุดท้ายของเดือน"
                  slotProps={{ htmlInput: { inputMode: 'numeric', sx: dataTextSx } }}
                />
                <TextField
                  type="date"
                  label="วันเริ่มต้น"
                  value={ruleForm.start_date}
                  onChange={setRuleField('start_date')}
                  required
                  slotProps={{ inputLabel: { shrink: true }, htmlInput: { sx: dataTextSx } }}
                />
                <TextField
                  type="date"
                  label="วันสิ้นสุด (ไม่บังคับ)"
                  value={ruleForm.end_date}
                  onChange={setRuleField('end_date')}
                  slotProps={{ inputLabel: { shrink: true }, htmlInput: { sx: dataTextSx } }}
                />
              </Box>
            </Box>

            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <TextField select label="บัญชีที่คาดว่าจะใช้" value={ruleForm.default_account_id} onChange={setRuleField('default_account_id')}>
                <MenuItem value="">
                  <em>— ไม่ระบุ —</em>
                </MenuItem>
                {accounts.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.nickname}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select label="หมวด (ไม่บังคับ)" value={ruleForm.category_id} onChange={setRuleField('category_id')}>
                <MenuItem value="">
                  <em>— ไม่ระบุ —</em>
                </MenuItem>
                {categories.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Box>

            {formError && <Alert severity="error">{formError}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setRuleModalOpen(false)} disabled={submitting}>
                ยกเลิก
              </Button>
              <Button type="submit" variant="contained" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'กำลังบันทึก…' : 'บันทึก'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>

      <Modal
        open={payingItem != null}
        title={`บันทึกการจ่าย — ${payingItemLive?.name ?? ''}`}
        onClose={() => setPayingItem(null)}
        busy={submitting}
      >
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            submitPayment();
          }}
        >
          <Stack spacing={2.5}>
            <Alert severity="info" sx={descriptionSx}>
              การบันทึกนี้เป็นการประกาศว่าจ่ายแล้ว ระบบ<strong>ไม่สร้างรายการธุรกรรมปลอม</strong> — จะขึ้นว่า
              &ldquo;จ่ายแล้ว รอ statement&rdquo; จนกว่า statement จริงจะมาถึงและจับคู่ได้ จ่ายบางส่วนบันทึกหลายครั้งได้
            </Alert>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <TextField
                label="จำนวนเงินที่จ่าย (บาท)"
                value={paymentForm.amount_baht}
                onChange={setPaymentField('amount_baht')}
                required
                error={paymentForm.amount_baht !== '' && parseBahtToSatang(paymentForm.amount_baht) == null}
                slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
              />
              <TextField
                type="date"
                label="วันที่จ่าย"
                value={paymentForm.paid_date}
                onChange={setPaymentField('paid_date')}
                required
                slotProps={{ inputLabel: { shrink: true }, htmlInput: { sx: dataTextSx } }}
              />
              <TextField select label="บัญชีที่จ่าย" value={paymentForm.bank_account_id} onChange={setPaymentField('bank_account_id')} required>
                <MenuItem value="">
                  <em>— เลือก —</em>
                </MenuItem>
                {accounts.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.nickname}
                  </MenuItem>
                ))}
              </TextField>
            </Box>

            {payingItemLive != null && payingItemLive.payments.length > 0 && (
              <Box component="section" aria-labelledby="payment-history-heading">
                <Typography component="h3" id="payment-history-heading" variant="body2" sx={{ fontWeight: 650, mb: 1 }}>
                  ที่ประกาศจ่ายไว้แล้ว
                </Typography>
                <Stack spacing={1}>
                  {payingItemLive.payments.map((p) => (
                    <Paper key={p.id} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}
                      >
                        <Box>
                          <Money satang={p.amount_satang} />
                          <Typography variant="body2" color="text.secondary">
                            <Box component="span" sx={dataTextSx}>
                              {formatDate(p.paid_date)}
                            </Box>{' '}
                            · {p.account_nickname} ·{' '}
                            {p.status === 'cancelled' ? 'ยกเลิกแล้ว' : 'บันทึกไว้แล้ว'}
                          </Typography>
                        </Box>
                        {p.status !== 'cancelled' && (
                          <Button
                            size="small"
                            color="error"
                            startIcon={<DeleteOutlineRounded />}
                            disabled={submitting}
                            onClick={() =>
                              void run(
                                () => patch(`/api/monthly-item-payments/${p.id}`, { status: 'cancelled' }),
                                'ยกเลิกการประกาศจ่ายแล้ว',
                              )
                            }
                          >
                            ยกเลิก
                          </Button>
                        )}
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              </Box>
            )}

            {formError && <Alert severity="error">{formError}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setPayingItem(null)} disabled={submitting}>
                ยกเลิก
              </Button>
              <Button type="submit" variant="contained" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'กำลังบันทึก…' : 'บันทึกการจ่าย'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>

      <ConfirmDialog
        open={closing}
        title="ปิดเดือนนี้"
        description="ปิดเดือนแล้วจะแก้รายการไม่ได้จนกดเปิดอีกครั้ง ระบบจะเก็บภาพสรุปตอนปิดไว้ตรวจย้อนหลัง — statement ที่มาถึงภายหลังยังจับคู่กับการจ่ายที่ประกาศไว้ได้ตามปกติ"
        confirmLabel="ปิดเดือน"
        confirmColor="warning"
        busy={submitting}
        onClose={() => setClosing(false)}
        onConfirm={() =>
          void run(() => post(`/api/monthly-plans/${month}/close`, {}), 'ปิดเดือนแล้ว', () => {
            setClosing(false);
            // ปุ่ม "ปิดเดือนนี้" ถูกแทนด้วยปุ่มเปิดเดือนแล้ว element ต้นทางไม่มีอยู่ให้คืน focus
            addItemButtonRef.current?.focus();
          })
        }
      />

      <ConfirmDialog
        open={archivingRule != null}
        title="เลิกใช้รายการประจำ"
        description={`เลิกใช้ "${archivingRule?.name ?? ''}" หรือไม่? เดือนถัดไปจะไม่สร้างรายการนี้ให้อีก รายการที่สร้างไว้แล้วยังอยู่ครบ — ตอนนี้ยังไม่มีปุ่มเปิดใช้กลับ ต้องสร้างกฎใหม่`}
        confirmLabel="เลิกใช้"
        confirmColor="error"
        busy={submitting}
        onClose={() => setArchivingRule(null)}
        onConfirm={() => {
          if (!archivingRule) return;
          void run(
            () => post(`/api/recurring-rules/${archivingRule.id}/archive`, {}),
            'ปิดใช้งานรายการประจำแล้ว — รายการที่สร้างไว้แล้วยังอยู่',
            () => setArchivingRule(null),
          );
        }}
      />

      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
