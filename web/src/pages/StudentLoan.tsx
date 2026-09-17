import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SchoolRounded from '@mui/icons-material/SchoolRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import EventAvailableRounded from '@mui/icons-material/EventAvailableRounded';
import PaymentsRounded from '@mui/icons-material/PaymentsRounded';
import PercentRounded from '@mui/icons-material/PercentRounded';
import SavingsRounded from '@mui/icons-material/SavingsRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import { put, req, type StudentLoanResponse, type StudentLoanScenario } from '../api.js';
import Money from '../components/Money.js';
import SummaryCard from '../components/SummaryCard.js';
import Modal from '../Modal.js';
import { formatBaht, formatDate, parseBahtToSatang } from '../format.js';
import { createFormFieldChangeHandler } from '../form.js';
import { dataTextSx } from '../theme.js';
import { EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from '../ui.js';

const SCENARIO_LABEL: Record<StudentLoanScenario, string> = {
  lump_sum: 'เก็บออมแล้วปิดทีเดียว',
  extra_monthly: 'โปะเข้า กยศ. ทุกเดือน',
  minimum_only: 'จ่ายขั้นต่ำอย่างเดียว',
};

const SCENARIO_HINT: Record<StudentLoanScenario, string> = {
  lump_sum: 'จ่าย กยศ. ตามปกติ เก็บเงินไว้ต่างหาก แล้วปิดบัญชีทีเดียวเมื่อเงินพอ (ได้ส่วนลดเงินต้น)',
  extra_monthly: 'เอาเงินที่จะเก็บออมส่งเข้า กยศ. ทุกเดือนแทน ดอกเบี้ยลดเร็วกว่าแต่ปิดช้ากว่า',
  minimum_only: 'ไม่โปะเลย เดินตามตาราง Step Up จนครบ 15 งวด',
};

const SCENARIOS: StudentLoanScenario[] = ['lump_sum', 'extra_monthly', 'minimum_only'];

/** รอให้พิมพ์นิ่งก่อนค่อยคำนวณใหม่ — สั้นกว่านี้หน้าจะกระตุกระหว่างพิมพ์ ยาวกว่านี้จะรู้สึกหน่วง */
const WHAT_IF_DEBOUNCE_MS = 500;

/** ต่างกันเกินเท่านี้ถือว่ากรอกเลขผิด ไม่ใช่ความคลาดเคลื่อนตามปกติ (500 บาท) */
const CALIBRATION_TOLERANCE_SATANG = 500 * 100;

type FormState = {
  principal_original_baht: string;
  first_due_date: string;
  as_of_date: string;
  principal_remaining_baht: string;
  interest_accrued_baht: string;
  app_annual_due_baht: string;
  monthly_payment_baht: string;
  monthly_saving_baht: string;
  savings_balance_baht: string;
  payoff_discount_percent: string;
  payment_day: string;
};

const EMPTY_FORM: FormState = {
  principal_original_baht: '',
  first_due_date: '',
  as_of_date: new Date().toISOString().slice(0, 10),
  principal_remaining_baht: '',
  interest_accrued_baht: '0',
  app_annual_due_baht: '',
  monthly_payment_baht: '',
  monthly_saving_baht: '',
  savings_balance_baht: '0',
  payoff_discount_percent: '3',
  payment_day: '5',
};

function toBaht(satang: number): string {
  return formatBaht(satang);
}

export default function StudentLoan() {
  const [data, setData] = useState<StudentLoanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [scenario, setScenario] = useState<StudentLoanScenario>('lump_sum');
  const [showMonthly, setShowMonthly] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // ลองปรับตัวเลขดูโดยไม่บันทึกทับของเดิม — ส่งเป็น query override ให้ server คำนวณใหม่
  const [whatIfSaving, setWhatIfSaving] = useState('');
  const [whatIfPayment, setWhatIfPayment] = useState('');
  // ค่าที่ "ยิงจริง" ตามหลังค่าที่พิมพ์อยู่ WHAT_IF_DEBOUNCE_MS — ผูก queryString กับ state ที่พิมพ์
  // ตรง ๆ จะยิง request ทุกครั้งที่กดคีย์ กว่าจะพิมพ์ 10000 ครบก็โหลดใหม่ไปห้ารอบ
  const [appliedSaving, setAppliedSaving] = useState('');
  const [appliedPayment, setAppliedPayment] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAppliedSaving(whatIfSaving);
      setAppliedPayment(whatIfPayment);
    }, WHAT_IF_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [whatIfSaving, whatIfPayment]);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    const saving = parseBahtToSatang(appliedSaving);
    if (saving != null) p.set('monthly_saving_satang', String(saving));
    const payment = parseBahtToSatang(appliedPayment);
    if (payment != null) p.set('monthly_payment_satang', String(payment));
    return p.toString();
  }, [appliedSaving, appliedPayment]);

  const reload = async () => {
    const requestId = (requestIdRef.current += 1);
    setLoading(true);
    setError('');
    try {
      const result = await req<StudentLoanResponse>(`/api/student-loan${queryString ? `?${queryString}` : ''}`);
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'โหลดข้อมูลหนี้ กยศ. ไม่สำเร็จ');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryString]);

  const openEdit = () => {
    const loan = data?.loan;
    setForm(
      loan == null
        ? EMPTY_FORM
        : {
            principal_original_baht: toBaht(loan.principal_original_satang),
            first_due_date: loan.first_due_date,
            as_of_date: loan.as_of_date,
            principal_remaining_baht: toBaht(loan.principal_remaining_satang),
            interest_accrued_baht: toBaht(loan.interest_accrued_satang),
            app_annual_due_baht: loan.app_annual_due_satang == null ? '' : toBaht(loan.app_annual_due_satang),
            monthly_payment_baht: toBaht(loan.monthly_payment_satang),
            monthly_saving_baht: toBaht(loan.monthly_saving_satang),
            savings_balance_baht: toBaht(loan.savings_balance_satang),
            payoff_discount_percent: String(loan.payoff_discount_bp / 100),
            payment_day: String(loan.payment_day),
          },
    );
    setFormError('');
    setModalOpen(true);
  };

  const submit = async () => {
    setFormError('');
    const required: [keyof FormState, string][] = [
      ['principal_original_baht', 'ยอดกู้ตามสัญญา'],
      ['principal_remaining_baht', 'เงินต้นคงเหลือ'],
      ['interest_accrued_baht', 'ดอกเบี้ยค้าง'],
      ['monthly_payment_baht', 'ยอดจ่ายต่อเดือน'],
      ['monthly_saving_baht', 'เงินเก็บต่อเดือน'],
      ['savings_balance_baht', 'เงินเก็บที่มีอยู่แล้ว'],
    ];
    const amounts: Record<string, number> = {};
    for (const [key, label] of required) {
      const satang = parseBahtToSatang(form[key]);
      if (satang == null) {
        setFormError(`${label} ไม่ถูกต้อง`);
        return;
      }
      amounts[key] = satang;
    }
    if (form.first_due_date === '' || form.as_of_date === '') {
      setFormError('ต้องกรอกวันครบกำหนดครั้งแรกและวันที่ของข้อมูล');
      return;
    }
    const discountPercent = Number(form.payoff_discount_percent);
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      setFormError('ส่วนลดปิดบัญชีต้องอยู่ระหว่าง 0–100%');
      return;
    }
    const paymentDay = Number(form.payment_day);
    if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 28) {
      setFormError('วันที่ชำระต้องอยู่ระหว่าง 1–28');
      return;
    }
    const appAnnualDue = form.app_annual_due_baht.trim() === '' ? null : parseBahtToSatang(form.app_annual_due_baht);
    if (form.app_annual_due_baht.trim() !== '' && appAnnualDue == null) {
      setFormError('ยอดครบกำหนดปีนี้ไม่ถูกต้อง');
      return;
    }

    setSubmitting(true);
    try {
      await put('/api/student-loan', {
        principal_original_satang: amounts.principal_original_baht,
        first_due_date: form.first_due_date,
        as_of_date: form.as_of_date,
        principal_remaining_satang: amounts.principal_remaining_baht,
        interest_accrued_satang: amounts.interest_accrued_baht,
        monthly_payment_satang: amounts.monthly_payment_baht,
        monthly_saving_satang: amounts.monthly_saving_baht,
        savings_balance_satang: amounts.savings_balance_baht,
        app_annual_due_satang: appAnnualDue,
        payoff_discount_bp: Math.round(discountPercent * 100),
        payment_day: paymentDay,
      });
      setNotice({ message: 'บันทึกข้อมูลหนี้ กยศ. แล้ว', severity: 'success' });
      setModalOpen(false);
      setWhatIfSaving('');
      setWhatIfPayment('');
      setAppliedSaving('');
      setAppliedPayment('');
      await reload();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'บันทึกไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  const onField = createFormFieldChangeHandler(setForm);
  const loan = data?.loan ?? null;
  const projection = data?.projections?.[scenario] ?? null;
  const current = projection?.installments.find((r) => r.is_current) ?? null;

  // เทียบยอดครบกำหนดปีนี้ที่แอปแจ้ง กับที่โมเดลคิดได้ — จับกรณีกรอกเลขผิดตั้งแต่ต้น
  // ต่างกันเล็กน้อยเป็นเรื่องปกติ เพราะเงินต้นคงเหลือ ณ 5 ก.ค. กับ ณ วันที่กรอกไม่เท่ากัน
  const calibration =
    loan?.app_annual_due_satang != null && current != null
      ? {
          entered: loan.app_annual_due_satang,
          modelled: current.total_satang,
          ok: Math.abs(loan.app_annual_due_satang - current.total_satang) <= CALIBRATION_TOLERANCE_SATANG,
        }
      : null;

  return (
    <>
      <PageHeader
        level={1}
        id="student-loan-heading"
        title="แผนปลดหนี้ กยศ."
        description="คำนวณจากตาราง Step Up 15 งวดของ กยศ. ดอกเบี้ย 1% ต่อปีเดินรายวันบนเงินต้นคงเหลือ และลำดับตัดชำระตาม พ.ร.บ. 2566 (เงินต้นงวดที่ครบกำหนด → ดอกเบี้ย → เบี้ยปรับ)"
        action={
          <Button variant="contained" onClick={openEdit}>
            {loan == null ? 'เพิ่มข้อมูลหนี้' : 'แก้ไขข้อมูล'}
          </Button>
        }
      />

      {error && <LoadError message={error} onRetry={() => void reload()} />}

      {loading && data == null ? (
        <TableSkeleton rows={6} />
      ) : loan == null || projection == null ? (
        <EmptyState
          icon={<SchoolRounded fontSize="large" />}
          title="ยังไม่มีข้อมูลหนี้ กยศ."
          description="กรอกยอดกู้ตามสัญญา วันครบกำหนดชำระครั้งแรก และยอดคงเหลือล่าสุดจากแอป กยศ. Connect แล้วระบบจะคำนวณให้ว่าจะปิดหนี้ได้เดือนไหน"
          action={<Button variant="contained" onClick={openEdit}>เพิ่มข้อมูลหนี้</Button>}
        />
      ) : (
        <Stack spacing={3} sx={{ mt: 3 }}>
          <Alert severity="info" icon={<EventAvailableRounded />}>
            ข้อมูล ณ วันที่ <Box component="span" sx={dataTextSx}>{formatDate(loan.as_of_date)}</Box> — ดอกเบี้ย กยศ.
            เดินทุกวัน ยิ่งทิ้งไว้นานตัวเลขยิ่งคลาด ควรกลับมาอัปเดตยอดคงเหลือเป็นระยะ
          </Alert>

          {/* ไม่มีสี warning ใน DESIGN.md (มีแค่ accent/income/expense/neutral) เหมือน DataFreshness.tsx
              จึงใช้ info ซึ่ง map ไปที่ colors.muted แล้วให้ไอคอน + ข้อความสื่อความหมายแทน */}
          {calibration && (
            <Alert
              severity={calibration.ok ? 'success' : 'info'}
              icon={calibration.ok ? <CheckCircleRounded /> : <WarningAmberRounded />}
            >
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  ยอดครบกำหนดงวดที่ {current!.installment_no} — แอปแจ้ง{' '}
                  <Money satang={calibration.entered} /> · โมเดลคิดได้ <Money satang={calibration.modelled} />
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {calibration.ok
                    ? 'ใกล้เคียงกัน แปลว่าเลขที่กรอกถูกต้อง'
                    : 'ต่างกันมาก — น่าจะกรอกยอดกู้ตามสัญญาหรือวันครบกำหนดครั้งแรกผิด ไม่ใช่การคำนวณผิด'}
                </Typography>
              </Stack>
            </Alert>
          )}

          <ToggleButtonGroup
            exclusive
            value={scenario}
            onChange={(_, v: StudentLoanScenario | null) => v && setScenario(v)}
            aria-label="เลือกแผนที่จะดูรายละเอียด"
          >
            {SCENARIOS.map((s) => (
              <ToggleButton key={s} value={s}>{SCENARIO_LABEL[s]}</ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="body2" color="text.secondary" sx={{ mt: -2 }}>{SCENARIO_HINT[scenario]}</Typography>

          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' } }}>
            <SummaryCard
              title="ปิดหนี้ได้เมื่อ"
              icon={<EventAvailableRounded fontSize="small" />}
              value={projection.payoff_date ? formatDate(projection.payoff_date) : 'ยังปิดไม่ได้'}
              caption={
                projection.payoff_date
                  ? `อีก ${projection.months_remaining} เดือน · งวดที่ ${projection.payoff_installment_no}`
                  : 'ยอดจ่ายไม่พอไล่ดอกเบี้ยทัน'
              }
            />
            <SummaryCard
              title="ยอดรวมที่ต้องจ่ายอีก"
              icon={<PaymentsRounded fontSize="small" />}
              value={<Money satang={projection.total_payment_satang} />}
              caption={
                projection.final_payoff_satang > 0
                  ? `ก้อนปิดบัญชี ฿${formatBaht(projection.final_payoff_satang)}`
                  : 'จ่ายจนหมดตามตาราง ไม่มีก้อนปิดบัญชี'
              }
            />
            <SummaryCard
              title="ดอกเบี้ยที่ต้องจ่ายอีก"
              icon={<PercentRounded fontSize="small" />}
              value={<Money satang={projection.total_interest_satang} tone="expense" />}
              caption="ค้างอยู่ตอนนี้ + ที่จะเดินต่อจนปิด"
            />
            <SummaryCard
              title="ส่วนลดที่ได้"
              icon={<SavingsRounded fontSize="small" />}
              value={<Money satang={projection.discount_satang} tone="income" />}
              caption={
                projection.discount_satang > 0
                  ? `ลดเงินต้น ${loan.payoff_discount_bp / 100}% จากการปิดก่อนกำหนด`
                  : 'ไม่ได้ปิดก่อนกำหนด จึงไม่มีส่วนลด'
              }
            />
          </Box>

          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography variant="h2" sx={{ fontSize: '1.25rem', mb: 1 }}>เทียบสามทางเลือก</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              ตัวเลขชุดเดียวกัน ต่างกันแค่ว่าเอาเงินที่เก็บได้ไปทำอะไร
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ทางเลือก</TableCell>
                  <TableCell align="right">ปิดหนี้เมื่อ</TableCell>
                  <TableCell align="right">จ่ายรวมอีก</TableCell>
                  <TableCell align="right">ดอกเบี้ยรวม</TableCell>
                  <TableCell align="right">ส่วนลด</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {SCENARIOS.map((s) => {
                  const p = data!.projections![s];
                  return (
                    <TableRow key={s} selected={s === scenario}>
                      <TableCell>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <span>{SCENARIO_LABEL[s]}</span>
                          {s === scenario && <Chip size="small" label="กำลังดู" variant="outlined" />}
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={dataTextSx}>
                        {p.payoff_date ? formatDate(p.payoff_date) : '—'}
                      </TableCell>
                      <TableCell align="right"><Money satang={p.total_payment_satang} /></TableCell>
                      <TableCell align="right"><Money satang={p.total_interest_satang} tone="expense" /></TableCell>
                      <TableCell align="right"><Money satang={p.discount_satang} tone="income" /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Paper>

          <Paper variant="outlined" sx={{ p: 3 }}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
              <Typography variant="h2" sx={{ fontSize: '1.25rem' }}>ลองปรับตัวเลขดู</Typography>
              {/* หน้าไม่ถูกล้างเป็น skeleton ระหว่างคำนวณใหม่แล้ว จึงต้องมีอะไรบอกว่ากำลังทำงานอยู่ */}
              {loading && <CircularProgress size={16} aria-label="กำลังคำนวณใหม่" />}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              พิมพ์เสร็จแล้วรอครู่เดียวจะคำนวณใหม่ให้เอง ไม่บันทึกทับของเดิม (ว่างไว้ = ใช้ค่าที่บันทึกไว้)
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="จ่าย กยศ. ต่อเดือน (บาท)"
                value={whatIfPayment}
                onChange={(e) => setWhatIfPayment(e.target.value)}
                placeholder={toBaht(loan.monthly_payment_satang)}
                fullWidth
                helperText="ต่ำกว่าขั้นต่ำของงวดไหน ระบบใช้ขั้นต่ำของงวดนั้นแทน"
              />
              <TextField
                label="เก็บออมต่อเดือน (บาท)"
                value={whatIfSaving}
                onChange={(e) => setWhatIfSaving(e.target.value)}
                placeholder={toBaht(loan.monthly_saving_satang)}
                fullWidth
                helperText="เงินที่กันไว้จ่ายก้อนเดียวตอนปิดบัญชี"
              />
            </Stack>
          </Paper>

          <Paper variant="outlined" sx={{ p: 3 }}>
            <Typography variant="h2" sx={{ fontSize: '1.25rem', mb: 1 }}>ตารางงวดรายปี</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              เงินต้นแต่ละงวดคิดเป็น % ของยอดกู้ตามสัญญา และเพิ่มขึ้นทุกปี — ขั้นต่ำต่อเดือนจึงไม่ใช่ตัวเลขคงที่
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>งวดที่</TableCell>
                  <TableCell>ครบกำหนด</TableCell>
                  <TableCell align="right">เงินต้น</TableCell>
                  <TableCell align="right">ดอกเบี้ย</TableCell>
                  <TableCell align="right">รวมทั้งงวด</TableCell>
                  <TableCell align="right">ขั้นต่ำ/เดือน</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {projection.installments.map((row) => (
                  <TableRow key={row.installment_no} selected={row.is_current}>
                    <TableCell sx={dataTextSx}>
                      {row.installment_no}
                      {row.is_current && <Chip size="small" label="งวดปัจจุบัน" variant="outlined" sx={{ ml: 1 }} />}
                    </TableCell>
                    <TableCell sx={dataTextSx}>{formatDate(row.due_date)}</TableCell>
                    <TableCell align="right"><Money satang={row.principal_satang} /></TableCell>
                    <TableCell align="right"><Money satang={row.interest_satang} /></TableCell>
                    <TableCell align="right"><Money satang={row.total_satang} /></TableCell>
                    <TableCell align="right"><Money satang={row.min_monthly_satang} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>

          <Paper variant="outlined" sx={{ p: 3 }}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
              <Typography variant="h2" sx={{ fontSize: '1.25rem' }}>
                ตารางรายเดือน ({projection.monthly.length} เดือน)
              </Typography>
              <Button onClick={() => setShowMonthly((v) => !v)}>{showMonthly ? 'ซ่อน' : 'ดูทั้งหมด'}</Button>
            </Stack>
            {showMonthly && (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>วันที่</TableCell>
                    <TableCell align="right">เงินต้นคงเหลือ</TableCell>
                    <TableCell align="right">ดอกเบี้ยเดือนนี้</TableCell>
                    <TableCell align="right">จ่าย</TableCell>
                    <TableCell align="right">เงินออมสะสม</TableCell>
                    <TableCell align="right">ยอดปิดบัญชี</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {projection.monthly.map((row) => (
                    <TableRow key={row.date}>
                      <TableCell sx={dataTextSx}>{formatDate(row.date)}</TableCell>
                      <TableCell align="right"><Money satang={row.closing_principal_satang} /></TableCell>
                      <TableCell align="right"><Money satang={row.interest_accrued_satang} tone="expense" /></TableCell>
                      <TableCell align="right"><Money satang={row.paid_satang} /></TableCell>
                      <TableCell align="right"><Money satang={row.savings_satang} /></TableCell>
                      <TableCell align="right"><Money satang={row.payoff_quote_satang} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        </Stack>
      )}

      <Modal open={modalOpen} title="ข้อมูลหนี้ กยศ." onClose={() => setModalOpen(false)} busy={submitting}>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            ตัวเลขทั้งหมดดูได้จากแอป กยศ. Connect — ยอดกู้ตามสัญญาคือยอดตั้งต้นทั้งหมด ไม่ใช่ยอดคงเหลือ
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="ยอดกู้ตามสัญญา (บาท)"
              value={form.principal_original_baht}
              onChange={onField('principal_original_baht')}
              required
              fullWidth
              helperText="ฐานของตาราง Step Up ทุกงวด"
            />
            <TextField
              label="วันครบกำหนดชำระครั้งแรก"
              type="date"
              value={form.first_due_date}
              onChange={onField('first_due_date')}
              required
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="5 ก.ค. แรกหลังพ้นช่วงปลอดหนี้ 2 ปี"
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="ข้อมูล ณ วันที่"
              type="date"
              value={form.as_of_date}
              onChange={onField('as_of_date')}
              required
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
              helperText="วันที่เปิดแอปดูยอดคงเหลือชุดนี้"
            />
            <TextField
              label="เงินต้นคงเหลือ (บาท)"
              value={form.principal_remaining_baht}
              onChange={onField('principal_remaining_baht')}
              required
              fullWidth
            />
            <TextField
              label="ดอกเบี้ยค้าง (บาท)"
              value={form.interest_accrued_baht}
              onChange={onField('interest_accrued_baht')}
              required
              fullWidth
              helperText={(() => {
                const p = parseBahtToSatang(form.principal_remaining_baht);
                const i = parseBahtToSatang(form.interest_accrued_baht);
                return p != null && i != null ? `เงินต้นรวมดอกเบี้ย ฿${formatBaht(p + i)}` : 'ยอดดอกเบี้ยรวม ณ ปัจจุบัน';
              })()}
            />
          </Stack>

          <TextField
            label="ยอดครบกำหนดปีนี้ตามแอป (บาท)"
            value={form.app_annual_due_baht}
            onChange={onField('app_annual_due_baht')}
            fullWidth
            helperText="ไม่บังคับ — ใส่ไว้เพื่อให้ระบบเทียบว่าเลขที่กรอกด้านบนถูกต้องไหม ไม่ได้เข้าสูตรคำนวณ"
          />

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="จ่าย กยศ. ต่อเดือน (บาท)"
              value={form.monthly_payment_baht}
              onChange={onField('monthly_payment_baht')}
              required
              fullWidth
              helperText="ต่ำกว่าขั้นต่ำของงวดไหน ระบบใช้ขั้นต่ำแทน"
            />
            <TextField
              label="เก็บออมต่อเดือน (บาท)"
              value={form.monthly_saving_baht}
              onChange={onField('monthly_saving_baht')}
              required
              fullWidth
              helperText="เงินที่กันไว้จ่ายก้อนเดียวตอนปิดบัญชี"
            />
            <TextField
              label="เงินเก็บที่มีอยู่แล้ว (บาท)"
              value={form.savings_balance_baht}
              onChange={onField('savings_balance_baht')}
              required
              fullWidth
            />
          </Stack>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="ส่วนลดเมื่อปิดบัญชี (%)"
              value={form.payoff_discount_percent}
              onChange={onField('payoff_discount_percent')}
              fullWidth
              helperText="ปัจจุบัน กยศ. ลดเงินต้น 3% เมื่อปิดทีเดียว — ปรับได้ถ้ามาตรการเปลี่ยน"
            />
            <TextField
              label="วันที่ชำระของทุกเดือน"
              value={form.payment_day}
              onChange={onField('payment_day')}
              fullWidth
              helperText="1–28"
            />
          </Stack>

          {formError && <Alert severity="error">{formError}</Alert>}

          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button color="inherit" onClick={() => setModalOpen(false)} disabled={submitting}>ยกเลิก</Button>
            <Button variant="contained" onClick={() => void submit()} disabled={submitting} aria-busy={submitting}>
              {submitting ? 'กำลังบันทึก…' : 'บันทึก'}
            </Button>
          </Stack>
        </Stack>
      </Modal>

      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </>
  );
}
