import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Stack, Typography } from '@mui/material';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded';
import CallReceivedRounded from '@mui/icons-material/CallReceivedRounded';
import CallMadeRounded from '@mui/icons-material/CallMadeRounded';
import CategoryRounded from '@mui/icons-material/CategoryRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import EventBusyRounded from '@mui/icons-material/EventBusyRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import FactCheckRounded from '@mui/icons-material/FactCheckRounded';
import PaidRounded from '@mui/icons-material/PaidRounded';
import SwapHorizRounded from '@mui/icons-material/SwapHorizRounded';
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded';
import {
  req,
  type AccountBalances,
  type AccountCoverage,
  type CashFlow,
  type CategoryBreakdown,
  type MonthlyPlan,
  type ReportSummary,
} from '../api.js';
import ChartCard from '../components/ChartCard.js';
import DataFreshness from '../components/DataFreshness.js';
import Money from '../components/Money.js';
import MonthPicker, { currentMonth } from '../components/MonthPicker.js';
import SummaryCard from '../components/SummaryCard.js';
import { categoryPalette, colors, dataTextSx } from '../theme.js';
import { formatBaht, formatDate, formatDateTime } from '../format.js';
import { LoadError, PageHeader, TableSkeleton } from '../ui.js';

const COVERAGE_NOTE_LINES = ['ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น', 'ไม่รวมเงินสดและ e-Wallet'];

function monthsBack(month: string, count: number): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1 - (count - 1), 1));
  const end = new Date(Date.UTC(y, m, 1));
  const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { from: iso(start), to: iso(new Date(end.getTime() - 86400000)) };
}

export default function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const month = searchParams.get('month') ?? currentMonth();

  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [breakdown, setBreakdown] = useState<CategoryBreakdown | null>(null);
  const [cashFlow, setCashFlow] = useState<CashFlow | null>(null);
  const [balances, setBalances] = useState<AccountBalances | null>(null);
  const [coverage, setCoverage] = useState<AccountCoverage[]>([]);
  const [plan, setPlan] = useState<MonthlyPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    // เคลียร์ของเดือนก่อนหน้าทิ้งก่อนยิงคำขอใหม่เสมอ — ไม่งั้น request ที่ fail (Promise.allSettled เขียน
    // เฉพาะฝั่ง fulfilled) จะเหลือตัวเลขของเดือนก่อนค้างอยู่ใต้ label เดือนใหม่ที่ MonthPicker เปลี่ยนไปแล้ว
    setSummary(null);
    setBreakdown(null);
    setCashFlow(null);
    setBalances(null);
    setCoverage([]);
    setPlan(null);
    setLoading(true);
    setError('');
    void (async () => {
      const { from } = monthsBack(month, 6);
      const { to } = monthsBack(month, 1);
      const [summaryR, breakdownR, cashFlowR, balancesR, coverageR, planR] = await Promise.allSettled([
        req<ReportSummary>(`/api/reports/summary?month=${month}`),
        req<CategoryBreakdown>(`/api/reports/category-breakdown?month=${month}`),
        req<CashFlow>(`/api/reports/cash-flow?from=${from}&to=${to}`),
        req<AccountBalances>(`/api/reports/account-balances?month=${month}`),
        req<{ rows: AccountCoverage[] }>('/api/reports/data-coverage'),
        // การ์ดวางแผนอ่านจาก endpoint เดียวกับหน้า /planning เพื่อไม่ให้ตัวเลขสองที่คำนวณคนละสูตร
        req<MonthlyPlan>(`/api/monthly-plans/${month}`),
      ]);
      if (requestId !== requestIdRef.current) return; // เปลี่ยนเดือนไปแล้วระหว่างรอ — ทิ้งผลลัพธ์ที่มาช้า
      const failures: string[] = [];
      if (summaryR.status === 'fulfilled') setSummary(summaryR.value); else failures.push('สรุปยอด');
      if (breakdownR.status === 'fulfilled') setBreakdown(breakdownR.value); else failures.push('ค่าใช้จ่ายตามหมวด');
      if (cashFlowR.status === 'fulfilled') setCashFlow(cashFlowR.value); else failures.push('แนวโน้มรายรับรายจ่าย');
      if (balancesR.status === 'fulfilled') setBalances(balancesR.value); else failures.push('แนวโน้มยอดคงเหลือ');
      if (coverageR.status === 'fulfilled') setCoverage(coverageR.value.rows); else failures.push('ความสดของข้อมูล');
      if (planR.status === 'fulfilled') setPlan(planR.value); else failures.push('แผนรายเดือน');
      if (failures.length > 0) setError(`โหลดไม่สำเร็จ: ${failures.join(', ')}`);
      setLoading(false);
    })();
  }, [month]);

  // ทุกการ์ด/กราฟคำนวณจาก EXCLUDED_FROM_FLOW_SQL (ตัดโอนภายในออกแล้ว) ยกเว้นการ์ดโอนภายในเอง — ต้องส่ง
  // is_internal_transfer=false เป็นค่าตั้งต้นเสมอ ไม่งั้น list ปลายทางรวมโอนภายในที่การ์ดตัดออกไปแล้ว ตัวเลข
  // จะไม่ตรงกัน (ผู้ใช้กด "เงินเข้า" แล้วเจอยอดในตารางมากกว่าที่การ์ดบอก) การ์ดที่ต้องการเห็นโอนภายในส่ง
  // is_internal_transfer: 'true' มาทับค่าตั้งต้นนี้ได้ตามปกติ
  const goTransactions = (params: Record<string, string>) => {
    const p = new URLSearchParams({ month, is_internal_transfer: 'false', ...params });
    navigate(`/transactions?${p.toString()}`);
  };

  return (
    <Box>
      <PageHeader
        level={1}
        id="dashboard-heading"
        title="แดชบอร์ด"
        action={
          <MonthPicker
            value={month}
            onChange={(m) => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('month', m); return next; })}
          />
        }
      />
      <Stack sx={{ mt: 0.5 }}>
        {COVERAGE_NOTE_LINES.map((line) => (
          <Typography key={line} variant="body2" color="text.secondary">{line}</Typography>
        ))}
      </Stack>

      {error && <LoadError message={error} />}

      {loading && <TableSkeleton rows={6} />}

      {!loading && summary && (
        <Stack spacing={4} sx={{ mt: 3 }}>
          <Box component="section" aria-labelledby="actual-heading">
            <Typography variant="h2" id="actual-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>เงินจริงจาก Statement</Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <SummaryCard
                title="เงินเข้า"
                icon={<CallReceivedRounded fontSize="small" />}
                value={<Money satang={summary.money_in_satang} tone="income" />}
                onClick={() => goTransactions({ direction: 'credit' })}
              />
              <SummaryCard
                title="เงินออก"
                icon={<CallMadeRounded fontSize="small" />}
                value={<Money satang={summary.money_out_satang} tone="expense" />}
                onClick={() => goTransactions({ direction: 'debit' })}
              />
              <SummaryCard
                title="กระแสเงินสดสุทธิ"
                icon={<TrendingUpRounded fontSize="small" />}
                value={<Money satang={summary.net_satang} tone={summary.net_satang >= 0 ? 'income' : 'expense'} showSign />}
                onClick={() => goTransactions({})}
              />
              {/* ไม่มี onClick โดยตั้งใจ — เป็นยอดรวมข้าม "ทุกบัญชี" ไม่มีตาราง/บัญชีเดียวที่เป็น "รายการต้นทาง"
                  ของยอดรวมนี้ได้จริง (ต่างจากการ์ดอื่นที่ drill ไปยัง transaction ต้นทางเจาะจงได้) */}
              <SummaryCard
                title="ยอดคงเหลือรวมล่าสุด"
                icon={<AccountBalanceRounded fontSize="small" />}
                value={<Money satang={summary.total_balance_satang} />}
              />
              <SummaryCard
                title="โอนภายใน (ไม่นับรายรับ/รายจ่าย)"
                icon={<SwapHorizRounded fontSize="small" />}
                value={<Money satang={summary.internal_transfer_excluded_satang} />}
                caption={`${summary.internal_transfer_count} รายการ (นับสองขา)`}
                onClick={() => goTransactions({ is_internal_transfer: 'true' })}
              />
            </Box>
          </Box>

          <Box component="section" aria-labelledby="quality-heading">
            <Typography variant="h2" id="quality-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>คุณภาพข้อมูล</Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <SummaryCard
                title="ยังไม่ได้จัดหมวด"
                icon={<CategoryRounded fontSize="small" />}
                value={<Box component="span" sx={dataTextSx}>{summary.uncategorised_count.toLocaleString('th-TH')}</Box>}
                caption="รายการ"
                onClick={() => goTransactions({ uncategorised: '1' })}
              />
              <SummaryCard
                title="ยังไม่ตรวจสอบ"
                icon={<FactCheckRounded fontSize="small" />}
                value={<Box component="span" sx={dataTextSx}>{summary.unreviewed_count.toLocaleString('th-TH')}</Box>}
                caption="รายการ"
                onClick={() => goTransactions({ review_status: 'unreviewed' })}
              />
              <SummaryCard
                title="Statement อ่านไฟล์ไม่สำเร็จ"
                icon={<ErrorOutlineRounded fontSize="small" />}
                value={<Box component="span" sx={dataTextSx}>{(summary.statement_health.find((s) => s.status === 'parse_failed')?.n ?? 0).toLocaleString('th-TH')}</Box>}
                caption="ทั้งหมด (ไม่ผูกกับเดือนที่เลือก)"
              />
              <SummaryCard
                title="Statement checksum ไม่ผ่าน"
                icon={<ErrorOutlineRounded fontSize="small" />}
                value={<Box component="span" sx={dataTextSx}>{(summary.statement_health.find((s) => s.status === 'checksum_failed')?.n ?? 0).toLocaleString('th-TH')}</Box>}
                caption="ทั้งหมด (ไม่ผูกกับเดือนที่เลือก)"
              />
              <SummaryCard
                title="บัญชีที่ข้อมูลอาจขาดช่วง"
                icon={<EventBusyRounded fontSize="small" />}
                value={<Box component="span" sx={dataTextSx}>{coverage.filter((a) => a.statement_behind).length.toLocaleString('th-TH')}</Box>}
                caption="ดูรายละเอียดด้านล่าง"
              />
            </Box>
            {summary.failed_statements.length > 0 && (
              <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
                <Stack spacing={0.5}>
                  {summary.failed_statements.slice(0, 5).map((s) => (
                    <Typography key={s.id} variant="body2" sx={dataTextSx}>
                      {s.account_nickname} · {s.status === 'parse_failed' ? 'อ่านไฟล์ไม่สำเร็จ' : 'checksum ไม่ผ่าน'} · {formatDateTime(s.created_at)}
                    </Typography>
                  ))}
                </Stack>
              </Alert>
            )}
          </Box>

          <Box component="section" aria-labelledby="dashboard-planning-heading">
            <Typography variant="h2" id="dashboard-planning-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>การวางแผนรายเดือน</Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <SummaryCard
                title="เงินเหลือใช้ตามแผน"
                icon={<EventRepeatRounded fontSize="small" />}
                value={<Money satang={plan?.totals.planned_available_satang ?? 0} tone={(plan?.totals.planned_available_satang ?? 0) < 0 ? 'expense' : 'income'} />}
                caption="รายได้เต็ม − รายการหัก − รายจ่ายตามแผน − เงินกันไว้"
                // GET /monthly-plans/:month สร้างแถวแผนให้เองแบบ lazy เพราะฉะนั้น plan ไม่เคยเป็น null
                // สำหรับเดือนที่เปิดดูได้ — เช็ค items.length ด้วย ไม่งั้นเดือนที่ไม่มีแผนเลยจะโชว์ ฿0.00
                // ซึ่งแยกไม่ออกจาก "วางแผนไว้พอดีเป็นศูนย์" (การ์ดข้าง ๆ เช็ค total_count === 0 อยู่แล้ว)
                disabled={plan == null || plan.items.length === 0}
                disabledReason="ยังไม่มีแผนของเดือนนี้"
                onClick={() => navigate(`/planning?month=${month}`)}
              />
              <SummaryCard
                title="สถานะการจ่ายบิล"
                icon={<PaidRounded fontSize="small" />}
                value={
                  <>
                    {plan?.payment_status.paid_count ?? 0}
                    <Box component="span" sx={{ color: 'text.secondary', fontSize: '1rem' }}>
                      {` / ${plan?.payment_status.total_count ?? 0} รายการ`}
                    </Box>
                  </>
                }
                caption={
                  plan == null
                    ? undefined
                    : `เกินกำหนด ${plan.payment_status.overdue_count} · จ่ายบางส่วน ${plan.payment_status.partial_count} · ยังไม่จ่าย ${plan.payment_status.unpaid_count}`
                }
                disabled={plan == null || plan.payment_status.total_count === 0}
                disabledReason="ยังไม่มีรายการที่ต้องจ่ายในเดือนนี้"
                onClick={() => navigate(`/planning?month=${month}`)}
              />
            </Box>
          </Box>

          <Box component="section" aria-labelledby="charts-heading">
            <Typography variant="h2" id="charts-heading" sx={{ fontSize: '1.25rem', mb: 1.5 }}>กราฟ</Typography>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <ChartCard title="รายรับเทียบรายจ่ายรายเดือน" empty={!cashFlow || cashFlow.rows.every((r) => r.money_in_satang === 0 && r.money_out_satang === 0)}>
                {cashFlow && (
                  <BarChart
                    height={280}
                    xAxis={[{ scaleType: 'band', data: cashFlow.rows.map((r) => r.month), valueFormatter: (m: string) => m.slice(2) }]}
                    series={[
                      { id: 'income', label: 'รายรับ', data: cashFlow.rows.map((r) => r.money_in_satang / 100), color: colors.income, valueFormatter: (v: number | null) => formatBaht(Math.round((v ?? 0) * 100)) },
                      { id: 'expense', label: 'รายจ่าย', data: cashFlow.rows.map((r) => r.money_out_satang / 100), color: colors.expense, valueFormatter: (v: number | null) => formatBaht(Math.round((v ?? 0) * 100)) },
                    ]}
                    onItemClick={(_event, item) => {
                      const row = cashFlow!.rows[item.dataIndex];
                      if (row) {
                        const p = new URLSearchParams({ month: row.month, is_internal_transfer: 'false', direction: item.seriesId === 'income' ? 'credit' : 'debit' });
                        navigate(`/transactions?${p.toString()}`);
                      }
                    }}
                    slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'top', horizontal: 'end' } } }}
                  />
                )}
              </ChartCard>

              <ChartCard title="ค่าใช้จ่ายแยกตามหมวด" empty={!breakdown || breakdown.rows.length === 0}>
                {breakdown && (
                  <PieChart
                    height={280}
                    series={[{
                      data: breakdown.rows.map((r, i) => ({
                        id: r.category_id ?? -1,
                        label: r.category_name,
                        value: r.total_satang / 100,
                        color: categoryPalette[i % categoryPalette.length],
                      })),
                      valueFormatter: (item: { value: number }) => formatBaht(Math.round(item.value * 100)),
                      innerRadius: 40,
                    }]}
                    onItemClick={(_event, item) => {
                      const row = breakdown.rows[item.dataIndex];
                      if (!row) return;
                      goTransactions(row.category_id == null ? { direction: 'debit', uncategorised: '1' } : { direction: 'debit', category_id: String(row.category_id) });
                    }}
                    slotProps={{ legend: { direction: 'vertical', position: { vertical: 'middle', horizontal: 'end' } } }}
                  />
                )}
              </ChartCard>

              <ChartCard title="แนวโน้มยอดคงเหลือตามบัญชี" empty={!balances || balances.rows.length === 0}>
                {balances && (() => {
                  // ทุกบัญชีเรียงบน x-axis วันที่ร่วมกันชุดเดียว — วันที่บัญชีหนึ่งไม่มี txn ค่าเป็น null
                  // (ไม่ใช่ "ไม่มีข้อมูล" แต่ "ยอดไม่เปลี่ยนวันนั้น") connectNulls ลากเส้นทับช่องว่างนั้นให้ถูกต้อง
                  const dates = Array.from(new Set(balances.rows.map((r) => r.txn_date))).sort();
                  const accountIds = Array.from(new Set(balances.rows.map((r) => r.bank_account_id)));
                  return (
                    <LineChart
                      height={280}
                      xAxis={[{ scaleType: 'point', data: dates, valueFormatter: (d: string) => formatDate(d) }]}
                      series={accountIds.map((id, i) => {
                        const nickname = balances.rows.find((r) => r.bank_account_id === id)?.account_nickname ?? '';
                        const byDate = new Map(balances.rows.filter((r) => r.bank_account_id === id).map((r) => [r.txn_date, r.running_balance_satang / 100]));
                        return {
                          id: String(id),
                          label: nickname,
                          data: dates.map((d) => byDate.get(d) ?? null),
                          color: categoryPalette[i % categoryPalette.length],
                          valueFormatter: (v: number | null) => (v == null ? '' : formatBaht(Math.round(v * 100))),
                          connectNulls: true,
                        };
                      })}
                      onMarkClick={(_event, item) => goTransactions({ bank_account_id: String(item.seriesId) })}
                      slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'top', horizontal: 'end' } } }}
                    />
                  );
                })()}
              </ChartCard>
            </Box>
          </Box>

          <DataFreshness accounts={coverage} />
        </Stack>
      )}
    </Box>
  );
}
