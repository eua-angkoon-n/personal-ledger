import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert, Box, Button, Chip, Collapse, Divider, IconButton, MenuItem, Paper, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import CalculateRounded from '@mui/icons-material/CalculateRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import PrintRounded from '@mui/icons-material/PrintRounded';
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded';
import { post, req, type TaxCalculationSnapshot, type TaxEntity, type TaxSummary as TaxSummaryResponse } from '../api.js';
import DeductionClaimSection from '../components/DeductionClaimSection.js';
import Money from '../components/Money.js';
import SummaryCard from '../components/SummaryCard.js';
import { formatDate, formatDateTime } from '../format.js';
import { dataTextSx } from '../theme.js';
import { EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from '../ui.js';

// §16 ข้อ 13 ของแผนต้นฉบับ — ทุกรายงานต้องระบุว่าไม่รวมเงินสดและ e-Wallet (หน้านี้เป็นรายงานการเงินที่ใหญ่ที่สุด
// ในระบบ ตัวเลขมาจาก txn ที่ import จาก statement เท่านั้น เหมือน Dashboard/Transactions/MonthlyPlan/Installments)
const COVERAGE_NOTE = 'ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น ไม่รวมเงินสดและ e-Wallet';

function currentTaxYearCE(): number {
  return new Date().getFullYear();
}

const YEAR_OPTIONS = (() => {
  const y = currentTaxYearCE();
  return [y - 2, y - 1, y, y + 1];
})();

export default function TaxSummary() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const year = Number(searchParams.get('year') ?? currentTaxYearCE());
  const taxEntityId = searchParams.get('tax_entity_id') ?? '';

  const [entities, setEntities] = useState<TaxEntity[]>([]);
  const [summary, setSummary] = useState<TaxSummaryResponse | null>(null);
  const [snapshots, setSnapshots] = useState<TaxCalculationSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [revision, setRevision] = useState(0);
  const [expandedSnapshotId, setExpandedSnapshotId] = useState<number | null>(null);

  useEffect(() => {
    let current = true;
    req<TaxEntity[]>('/api/tax-entities').then((rows) => {
      if (!current) return;
      setEntities(rows);
      if (taxEntityId === '' && rows.length > 0) setSearchParams((p) => { const n = new URLSearchParams(p); n.set('tax_entity_id', String(rows[0]!.id)); return n; }, { replace: true });
    });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (taxEntityId === '') return;
    let current = true;
    setLoading(true); setError('');
    Promise.all([
      req<TaxSummaryResponse>(`/api/tax/${year}/summary?tax_entity_id=${taxEntityId}`),
      req<{ rows: TaxCalculationSnapshot[] }>(`/api/tax/${year}/snapshots?tax_entity_id=${taxEntityId}`),
    ])
      .then(([s, snaps]) => { if (current) { setSummary(s); setSnapshots(snaps.rows); } })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [year, taxEntityId, revision]);

  const goTransactions = (params: Record<string, string>) => {
    navigate(`/transactions?${new URLSearchParams(params).toString()}`);
  };

  const calculate = async () => {
    if (taxEntityId === '') return;
    setCalculating(true);
    try {
      await post(`/api/tax/${year}/calculate`, { tax_entity_id: Number(taxEntityId) });
      setNotice({ message: 'บันทึกประมาณการภาษีแล้ว', severity: 'success' });
      setRevision((n) => n + 1);
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : 'คำนวณไม่สำเร็จ', severity: 'error' });
    } finally {
      setCalculating(false);
    }
  };

  const entity = entities.find((e) => String(e.id) === taxEntityId);
  const e = summary?.estimate;

  return (
    <Box>
      <PageHeader
        level={1}
        id="tax-summary-heading"
        title="ประมาณการภาษี"
        description='สรุปรายได้ ค่าใช้จ่าย และค่าลดหย่อนตาม Tax Entity และปีภาษี — ผลลัพธ์เป็น "ประมาณการภาษี" เสมอ ไม่ใช่ยอดที่ต้องชำระจริง ผู้ใช้ต้องตรวจสอบและยืนยัน Tax Treatment เองทุกครั้ง'
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{COVERAGE_NOTE}</Typography>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 3, alignItems: { sm: 'center' }, flexWrap: 'wrap' }}>
        <TextField
          select size="small" label="ปีภาษี (ค.ศ.)" value={year}
          onChange={(e2) => setSearchParams((p) => { const n = new URLSearchParams(p); n.set('year', e2.target.value); return n; })}
          sx={{ minWidth: 120 }}
        >
          {YEAR_OPTIONS.map((y) => <MenuItem key={y} value={y}>{y}</MenuItem>)}
        </TextField>
        <TextField
          select size="small" label="Tax Entity" value={taxEntityId}
          onChange={(e2) => setSearchParams((p) => { const n = new URLSearchParams(p); n.set('tax_entity_id', e2.target.value); return n; })}
          sx={{ minWidth: 200 }}
        >
          {entities.map((te) => <MenuItem key={te.id} value={te.id}>{te.display_name}</MenuItem>)}
        </TextField>
        <Box sx={{ flexGrow: 1 }} />
        <Button startIcon={<CalculateRounded />} variant="outlined" disabled={calculating || taxEntityId === ''} onClick={() => void calculate()}>
          {calculating ? 'กำลังคำนวณ…' : 'คำนวณและบันทึก'}
        </Button>
        <Button
          component="a" startIcon={<DownloadRounded />} variant="outlined"
          href={taxEntityId ? `/api/tax/${year}/export.csv?tax_entity_id=${taxEntityId}` : undefined}
          disabled={taxEntityId === ''}
          download
        >
          CSV
        </Button>
        <Button startIcon={<PrintRounded />} variant="outlined" onClick={() => window.print()}>พิมพ์ (PDF)</Button>
      </Stack>

      {entities.length === 0 && !loading && (
        <Alert severity="info" sx={{ mt: 3 }}>ยังไม่มี Tax Entity — เพิ่มได้จากหน้าบัญชีของฉัน ก่อนเริ่มดูประมาณการภาษี</Alert>
      )}

      {error && <LoadError message={error} onRetry={() => setRevision((n) => n + 1)} />}

      {loading ? <TableSkeleton rows={4} /> : summary && (
        <>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', mt: 3 }}>
            <SummaryCard title="เงินได้จากงานประจำ" value={<Money satang={summary.inputs.employmentIncomeSatang} tone="income" />} caption="income_record ของ Tax Entity นี้ในปีภาษีนี้" />
            <SummaryCard
              title="รายได้ธุรกิจอื่น"
              value={<Money satang={summary.inputs.otherIncomeSatang} tone="income" />}
              onClick={() => goTransactions(summary.drilldown_params.other_income)}
              caption="คลิกดูรายการธุรกรรม"
            />
            <SummaryCard
              title="ค่าใช้จ่ายหักภาษีได้"
              value={<Money satang={summary.inputs.deductibleExpenseSatang} tone="expense" />}
              onClick={() => goTransactions(summary.drilldown_params.deductible_expense)}
              caption="คลิกดูรายการธุรกรรม"
            />
            <SummaryCard title="ค่าลดหย่อนที่ยื่นขอ" value={<Money satang={summary.inputs.deductionClaimSatang} />} caption="รวมจากตารางค่าลดหย่อนด้านล่าง" />
            {e ? (
              <>
                <SummaryCard title="เงินได้สุทธิ (ประมาณการ)" value={<Money satang={e.netSatang} />} />
                <SummaryCard
                  title="ประมาณการยอดต้องชำระเพิ่ม/ขอคืน"
                  value={<Money satang={e.estimatedPayableSatang} tone={e.estimatedPayableSatang > 0 ? 'expense' : 'income'} showSign />}
                  caption={e.estimatedPayableSatang > 0 ? 'ต้องชำระเพิ่มโดยประมาณ' : 'ขอคืนได้โดยประมาณ'}
                />
              </>
            ) : (
              <SummaryCard title="ประมาณการภาษี" value="—" disabled disabledReason={summary.estimate_unavailable_reason ?? undefined} />
            )}
          </Box>

          {summary.employment_income_records.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>ที่มาของ "เงินได้จากงานประจำ" — คลิกดูรายการในหน้าแผนของเดือนนั้น</Typography>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                {summary.employment_income_records.map((r) => (
                  <Chip
                    key={r.id}
                    component={Link}
                    to={`/planning?month=${r.month_start.slice(0, 7)}`}
                    clickable
                    variant="outlined"
                    label={<>{r.name} ({r.income_date ? formatDate(r.income_date) : r.month_start.slice(0, 7)}): <Money satang={r.gross_amount_satang} /></>}
                  />
                ))}
              </Stack>
            </Box>
          )}

          {summary.inputs.withholdingCertificateSatang > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
              ยอดหัก ณ ที่จ่ายตามหนังสือรับรอง (เทียบ ไม่ได้บวกเข้าสูตร): <Money satang={summary.inputs.withholdingCertificateSatang} />
              {summary.inputs.withholdingCertificateSatang !== summary.inputs.withholdingSatang && ' — ยอดไม่ตรงกับที่หักในรายได้ ควรตรวจสอบ'}
            </Typography>
          )}

          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>Rule Version: <Box component="span" sx={dataTextSx}>{summary.rule_version}</Box></Typography>

          {e && (
            <Box sx={{ mt: 3 }}>
              <Typography variant="h2" sx={{ fontSize: '1.25rem', mb: 1.5 }}>รายละเอียดขั้นบันไดภาษี (ประมาณการ)</Typography>
              <TableContainer component={Paper} variant="outlined" tabIndex={0}>
                <Table size="small" sx={{ minWidth: 480 }}>
                  <TableHead><TableRow><TableCell>อัตราภาษี</TableCell><TableCell align="right">ภาษีในขั้นนี้</TableCell></TableRow></TableHead>
                  <TableBody>
                    {e.bracketBreakdown.filter((b) => b.taxSatang > 0 || b.rate === 0).map((b, i) => (
                      <TableRow key={i}>
                        <TableCell sx={dataTextSx}>{(b.rate * 100).toFixed(0)}%</TableCell>
                        <TableCell align="right"><Money satang={b.taxSatang} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Box>
          )}

          <Divider sx={{ my: 3 }} />

          <Box>
            <Typography variant="h2" sx={{ fontSize: '1.25rem', mb: 1.5 }}>รายการที่ยังขาดเอกสารหรือยังไม่ Review</Typography>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Chip
                icon={<ReceiptLongRounded />}
                label={`ยังไม่ระบุ Tax Treatment: ${summary.missing_document.untreated_txn_count}`}
                onClick={summary.missing_document.untreated_txn_count > 0 ? () => goTransactions(summary.drilldown_params.untreated_txn) : undefined}
                color={summary.missing_document.untreated_txn_count > 0 ? 'warning' : 'default'}
                variant="outlined"
              />
              <Chip
                label={`เอกสารที่ยังไม่ verified: ${summary.missing_document.draft_document_count}`}
                onClick={summary.missing_document.draft_document_count > 0 ? () => navigate(`/tax-documents?tax_entity_id=${taxEntityId}&tax_year=${year}&status=draft`) : undefined}
                color={summary.missing_document.draft_document_count > 0 ? 'warning' : 'default'}
                variant="outlined"
              />
              {summary.missing_document.unresolved_income_satang > 0 && (
                <Chip label={<>รายได้ที่ยัง resolve Tax Entity ไม่ได้: <Money satang={summary.missing_document.unresolved_income_satang} /></>} color="warning" variant="outlined" />
              )}
            </Stack>

            {summary.missing_document.unlinked_business_txn_count > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="body2" color="text.secondary">ธุรกรรมธุรกิจที่ยังไม่ผูกเอกสาร ({summary.missing_document.unlinked_business_txn_count}):</Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                  {summary.missing_document.unlinked_business_txn_samples.map((s) => (
                    <Chip key={s.id} component={Link} to={`/transactions?month=${s.txn_date.slice(0, 7)}&txn=${s.id}`} clickable variant="outlined" size="small"
                      label={<>{formatDate(s.txn_date)} {s.description}: <Money satang={s.amount_satang} /></>} />
                  ))}
                </Stack>
              </Box>
            )}

            {summary.missing_document.unlinked_claim_count > 0 && (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="body2" color="text.secondary">ค่าลดหย่อนที่ยังไม่ผูกเอกสาร ({summary.missing_document.unlinked_claim_count}):</Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mt: 0.5 }}>
                  {summary.missing_document.unlinked_claim_samples.map((s) => (
                    <Chip key={s.id} variant="outlined" size="small" label={<>{s.deduction_type}: <Money satang={s.claimed_amount_satang} /></>} />
                  ))}
                </Stack>
              </Box>
            )}
          </Box>

          <Divider sx={{ my: 3 }} />

          {taxEntityId !== '' && <DeductionClaimSection taxEntityId={Number(taxEntityId)} taxYear={year} onChanged={() => setRevision((n) => n + 1)} />}

          <Divider sx={{ my: 3 }} />

          <Box>
            <Typography variant="h2" sx={{ fontSize: '1.25rem', mb: 1.5 }}>ประวัติการคำนวณ</Typography>
            {snapshots.length === 0 ? (
              <EmptyState icon={<CalculateRounded sx={{ fontSize: 40 }} />} title="ยังไม่เคยคำนวณและบันทึก" description='กด "คำนวณและบันทึก" เพื่อเก็บ snapshot ของปีภาษีนี้ไว้เป็นหลักฐาน' />
            ) : (
              <TableContainer component={Paper} variant="outlined" tabIndex={0}>
                <Table size="small" sx={{ minWidth: 480 }}>
                  <TableHead><TableRow><TableCell /><TableCell>คำนวณเมื่อ</TableCell><TableCell>Rule Version</TableCell></TableRow></TableHead>
                  <TableBody>
                    {snapshots.map((s) => (
                      <Fragment key={s.id}>
                        <TableRow hover onClick={() => setExpandedSnapshotId((id) => (id === s.id ? null : s.id))} sx={{ cursor: 'pointer' }}>
                          <TableCell sx={{ width: 40 }}>
                            <IconButton size="small" aria-label="ดู Input Snapshot" sx={{ transform: expandedSnapshotId === s.id ? 'rotate(180deg)' : 'none' }}><ExpandMoreRounded fontSize="small" /></IconButton>
                          </TableCell>
                          <TableCell sx={dataTextSx}>{formatDateTime(s.calculated_at)}</TableCell>
                          <TableCell sx={dataTextSx}>{s.rule_version}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell colSpan={3} sx={{ py: 0, border: expandedSnapshotId === s.id ? undefined : 0 }}>
                            <Collapse in={expandedSnapshotId === s.id}>
                              <Box component="pre" sx={{ ...dataTextSx, fontSize: '0.75rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', my: 1.5 }}>
                                {JSON.stringify(s.input_snapshot, null, 2)}
                              </Box>
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Box>
        </>
      )}
      {entity?.entity_type !== 'individual' && summary && (
        <Alert severity="info" sx={{ mt: 3 }}>{summary.estimate_unavailable_reason}</Alert>
      )}
      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
