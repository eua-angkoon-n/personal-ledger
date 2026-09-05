import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Button,
  Chip,
  Collapse,
  MenuItem,
  Stack,
  TablePagination,
  TextField,
  Typography,
} from '@mui/material';
import FilterListRounded from '@mui/icons-material/FilterListRounded';
import ReceiptLongRounded from '@mui/icons-material/ReceiptLongRounded';
import { req, TAX_TREATMENT_LABEL, type Account, type Bank, type Category, type TaxEntity, type TaxTreatment, type TxnListResponse } from '../api.js';
import MonthPicker, { currentMonth } from '../components/MonthPicker.js';
import ReviewDrawer from '../components/ReviewDrawer.js';
import TransactionTable from '../components/TransactionTable.js';
import { parseBahtToSatang } from '../format.js';
import { dataTextSx } from '../theme.js';
import { EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from '../ui.js';

const LIMIT = 50;
const COVERAGE_NOTE = 'ข้อมูลเงินจริงคำนวณจาก Bank Statement ที่นำเข้าสู่ระบบเท่านั้น ไม่รวมเงินสดและ e-Wallet';

export default function Transactions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [taxEntities, setTaxEntities] = useState<TaxEntity[]>([]);
  const [data, setData] = useState<TxnListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const [minBahtInput, setMinBahtInput] = useState(searchParams.get('min_baht') ?? '');
  const [maxBahtInput, setMaxBahtInput] = useState(searchParams.get('max_baht') ?? '');
  const [selectedTxnId, setSelectedTxnId] = useState<number | null>(null);
  const linkedTxnId = searchParams.get('txn');
  useEffect(() => {
    const txnId = Number(linkedTxnId);
    setSelectedTxnId(linkedTxnId != null && Number.isSafeInteger(txnId) && txnId > 0 ? txnId : null);
  }, [linkedTxnId]);
  const [refreshing, setRefreshing] = useState(false);
  const requestIdRef = useRef(0);

  // drill-down จากหน้าภาษี (ทั้งปี ไม่ใช่รายเดือน) ส่ง from/to มาแทน month — ต้องไม่ถูก MonthPicker
  // เบียดทับด้วยเดือนปัจจุบันเงียบ ๆ ไม่งั้นตัวเลขที่ drill-down มาจากการ์ดกับที่เห็นในตารางไม่ตรงกัน
  const rangeFrom = searchParams.get('from');
  const rangeTo = searchParams.get('to');
  const monthParam = searchParams.get('month');
  const rangeMode = monthParam == null && rangeFrom != null && rangeTo != null;
  const month = monthParam ?? currentMonth();
  const bankAccountId = searchParams.get('bank_account_id') ?? '';
  const bankId = searchParams.get('bank_id') ?? '';
  const categoryId = searchParams.get('category_id') ?? '';
  const uncategorised = searchParams.get('uncategorised') === '1';
  const direction = searchParams.get('direction') ?? '';
  const accountPurpose = searchParams.get('account_purpose') ?? '';
  const isInternalTransfer = searchParams.get('is_internal_transfer') ?? '';
  const reviewStatus = searchParams.get('review_status') ?? '';
  const minBaht = searchParams.get('min_baht') ?? '';
  const maxBaht = searchParams.get('max_baht') ?? '';
  const taxTreatment = searchParams.get('tax_treatment') ?? '';
  const taxEntityIdFilter = searchParams.get('tax_entity_id') ?? '';
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
      const [accountsResult, banksResult, categoriesResult, taxEntitiesResult] = await Promise.allSettled([
        req<Account[]>('/api/accounts'),
        req<Bank[]>('/api/banks'),
        req<Category[]>('/api/categories?is_active=true'),
        req<TaxEntity[]>('/api/tax-entities'),
      ]);
      if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
      if (banksResult.status === 'fulfilled') setBanks(banksResult.value);
      if (categoriesResult.status === 'fulfilled') setCategories(categoriesResult.value);
      if (taxEntitiesResult.status === 'fulfilled') setTaxEntities(taxEntitiesResult.value);
    })();
  }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (rangeMode) { p.set('from', rangeFrom!); p.set('to', rangeTo!); } else { p.set('month', month); }
    if (bankAccountId) p.set('bank_account_id', bankAccountId);
    if (bankId) p.set('bank_id', bankId);
    if (categoryId) p.set('category_id', categoryId);
    if (uncategorised) p.set('uncategorised', 'true');
    if (direction) p.set('direction', direction);
    if (accountPurpose) p.set('account_purpose', accountPurpose);
    if (isInternalTransfer) p.set('is_internal_transfer', isInternalTransfer);
    if (reviewStatus) p.set('review_status', reviewStatus);
    if (taxTreatment) p.set('tax_treatment', taxTreatment);
    if (taxEntityIdFilter) p.set('tax_entity_id', taxEntityIdFilter);
    const minSatang = minBaht ? parseBahtToSatang(minBaht) : null;
    const maxSatang = maxBaht ? parseBahtToSatang(maxBaht) : null;
    if (minSatang != null) p.set('min_satang', String(minSatang));
    if (maxSatang != null) p.set('max_satang', String(maxSatang));
    if (q) p.set('q', q);
    p.set('limit', String(LIMIT));
    p.set('offset', String((page - 1) * LIMIT));
    return p.toString();
  }, [rangeMode, rangeFrom, rangeTo, month, bankAccountId, bankId, categoryId, uncategorised, direction, accountPurpose, isInternalTransfer, reviewStatus, taxTreatment, taxEntityIdFilter, minBaht, maxBaht, q, page]);

  // background=true (ยิงจาก ReviewDrawer.onSaved) = คำขอเดิมซ้ำ ไม่ใช่ filter เปลี่ยน — ไม่ unmount ตารางเป็น
  // skeleton (ไม่งั้น IconButton ที่ FocusTrap ของ drawer จำไว้คืน focus หายไปทุกครั้งที่บันทึก) และ error
  // จากคำขอ background ไม่ล้างแถวเดิมทิ้ง (ยังถูกต้องอยู่ก่อนบันทึกครั้งนี้) ต่างจาก error ตอน filter เปลี่ยนจริง
  // requestIdRef กัน response ที่มาไม่เรียงลำดับ (เช่น สลับบัญชีเร็ว ๆ) เขียนทับผลของคำขอล่าสุด
  const reload = async (background = false) => {
    const requestId = ++requestIdRef.current;
    if (background) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const result = await req<TxnListResponse>(`/api/transactions?${queryString}`);
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setError(e instanceof Error ? e.message : 'โหลดรายการธุรกรรมไม่สำเร็จ');
      if (!background) setData(null);
    } finally {
      if (requestId === requestIdRef.current) { setLoading(false); setRefreshing(false); }
    }
  };
  useEffect(() => { void reload(false); }, [queryString]);
  // q มาจาก URL ได้โดยไม่ผ่านการพิมพ์ (เช่น คลิก drill-down จากกราฟ) — sync ช่องค้นหาตามด้วย ไม่งั้นแสดงค่าเก่าค้าง
  useEffect(() => { setSearchInput(q); }, [q]);
  useEffect(() => { setMinBahtInput(minBaht); }, [minBaht]);
  useEffect(() => { setMaxBahtInput(maxBaht); }, [maxBaht]);

  // ยอดขั้นต่ำ/สูงสุด commit ตอน blur/Enter เหมือนช่องค้นหา ไม่ใช่ทุก keystroke (ไม่งั้นพิมพ์เลข 4 หลักได้ history
  // 4 entry และยิง API 4 ครั้ง) ค่าที่ parse ไม่ได้ไม่ commit เงียบ ๆ — ปล่อยให้ error state ในช่องค้างไว้แทน
  const commitAmountFilter = (field: 'min_baht' | 'max_baht', raw: string) => {
    if (raw.trim() === '') { setFilter({ [field]: null }); return; }
    if (parseBahtToSatang(raw) == null) return;
    setFilter({ [field]: raw });
  };

  const rows = data?.rows ?? [];
  const totalCount = data?.total_count ?? 0;
  const activeFilterCount = [bankId, categoryId, direction, accountPurpose, isInternalTransfer, reviewStatus, taxTreatment, taxEntityIdFilter, minBaht, maxBaht].filter(Boolean).length + (uncategorised ? 1 : 0);

  return (
    <Box>
      <PageHeader
        level={1}
        id="transactions-heading"
        title="ธุรกรรม"
        description="ตรวจสอบ จัดหมวด และยืนยันคู่โอนภายใน — ทุกรายการตรวจสอบย้อนกลับไปยัง statement ต้นทางได้"
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{COVERAGE_NOTE}</Typography>

      <Stack spacing={1.5} sx={{ mt: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: { sm: 'center' }, flexWrap: 'wrap' }}>
          <MonthPicker value={month} onChange={(m) => setFilter({ month: m, from: null, to: null })} />
          {rangeMode && (
            <Chip
              label={`ช่วง ${rangeFrom} – ${rangeTo}`}
              onDelete={() => setFilter({ from: null, to: null, month: currentMonth() })}
            />
          )}
          <TextField
            select
            size="small"
            label="บัญชี"
            value={bankAccountId}
            onChange={(e) => setFilter({ bank_account_id: e.target.value })}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">ทุกบัญชี</MenuItem>
            {accounts.map((a) => <MenuItem key={a.id} value={a.id}>{a.nickname}</MenuItem>)}
          </TextField>
          <TextField
            size="small"
            label="ค้นหารายการ"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onBlur={(e) => setFilter({ q: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') setFilter({ q: (e.target as HTMLInputElement).value }); }}
            sx={{ minWidth: 200, flexGrow: 1 }}
          />
          <Chip
            label="ยังไม่ตรวจสอบ"
            variant={reviewStatus === 'unreviewed' ? 'filled' : 'outlined'}
            color={reviewStatus === 'unreviewed' ? 'primary' : 'default'}
            onClick={() => setFilter({ review_status: reviewStatus === 'unreviewed' ? null : 'unreviewed' })}
            aria-pressed={reviewStatus === 'unreviewed'}
          />
          <Button
            size="small"
            startIcon={<FilterListRounded />}
            onClick={() => setShowMoreFilters((v) => !v)}
            color={activeFilterCount > 0 ? 'primary' : 'inherit'}
          >
            ตัวกรองเพิ่มเติม{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
        </Stack>

        <Collapse in={showMoreFilters}>
          <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1.5, pt: 0.5 }}>
            <TextField select size="small" label="ธนาคาร" value={bankId} onChange={(e) => setFilter({ bank_id: e.target.value })} sx={{ minWidth: 140 }}>
              <MenuItem value="">ทุกธนาคาร</MenuItem>
              {banks.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
            <TextField
              select
              size="small"
              label="หมวด"
              value={uncategorised ? '__uncategorised__' : categoryId}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '__uncategorised__') setFilter({ uncategorised: '1', category_id: null });
                else setFilter({ category_id: v || null, uncategorised: null });
              }}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">ทุกหมวด</MenuItem>
              <MenuItem value="__uncategorised__">ไม่ได้จัดหมวด</MenuItem>
              {categories.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="เข้า/ออก" value={direction} onChange={(e) => setFilter({ direction: e.target.value })} sx={{ minWidth: 120 }}>
              <MenuItem value="">ทั้งหมด</MenuItem>
              <MenuItem value="credit">เงินเข้า</MenuItem>
              <MenuItem value="debit">เงินออก</MenuItem>
            </TextField>
            <TextField select size="small" label="ประเภทบัญชี" value={accountPurpose} onChange={(e) => setFilter({ account_purpose: e.target.value })} sx={{ minWidth: 130 }}>
              <MenuItem value="">ทั้งหมด</MenuItem>
              <MenuItem value="personal">ส่วนตัว</MenuItem>
              <MenuItem value="business">ธุรกิจ</MenuItem>
            </TextField>
            <TextField select size="small" label="โอนภายใน" value={isInternalTransfer} onChange={(e) => setFilter({ is_internal_transfer: e.target.value })} sx={{ minWidth: 130 }}>
              <MenuItem value="">ทั้งหมด</MenuItem>
              <MenuItem value="true">เฉพาะโอนภายใน</MenuItem>
              <MenuItem value="false">ไม่รวมโอนภายใน</MenuItem>
            </TextField>
            <TextField select size="small" label="Tax Treatment" value={taxTreatment} onChange={(e) => setFilter({ tax_treatment: e.target.value })} sx={{ minWidth: 150 }}>
              <MenuItem value="">ทั้งหมด</MenuItem>
              <MenuItem value="none">ยังไม่ระบุ</MenuItem>
              {(Object.entries(TAX_TREATMENT_LABEL) as [TaxTreatment, string][]).map(([value, label]) => (
                <MenuItem key={value} value={value}>{label}</MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label="Tax Entity" value={taxEntityIdFilter} onChange={(e) => setFilter({ tax_entity_id: e.target.value })} sx={{ minWidth: 150 }}>
              <MenuItem value="">ทั้งหมด</MenuItem>
              {taxEntities.map((te) => <MenuItem key={te.id} value={te.id}>{te.display_name}</MenuItem>)}
            </TextField>
            <TextField
              size="small"
              label="ยอดขั้นต่ำ (บาท)"
              value={minBahtInput}
              onChange={(e) => setMinBahtInput(e.target.value)}
              onBlur={() => commitAmountFilter('min_baht', minBahtInput)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitAmountFilter('min_baht', minBahtInput); }}
              error={minBahtInput !== '' && parseBahtToSatang(minBahtInput) == null}
              helperText={minBahtInput !== '' && parseBahtToSatang(minBahtInput) == null ? 'รูปแบบไม่ถูกต้อง' : undefined}
              slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
              sx={{ width: 130 }}
            />
            <TextField
              size="small"
              label="ยอดสูงสุด (บาท)"
              value={maxBahtInput}
              onChange={(e) => setMaxBahtInput(e.target.value)}
              onBlur={() => commitAmountFilter('max_baht', maxBahtInput)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitAmountFilter('max_baht', maxBahtInput); }}
              error={maxBahtInput !== '' && parseBahtToSatang(maxBahtInput) == null}
              helperText={maxBahtInput !== '' && parseBahtToSatang(maxBahtInput) == null ? 'รูปแบบไม่ถูกต้อง' : undefined}
              slotProps={{ htmlInput: { inputMode: 'decimal', sx: dataTextSx } }}
              sx={{ width: 130 }}
            />
          </Stack>
        </Collapse>
      </Stack>

      {error && <LoadError message={error} onRetry={rows.length === 0 ? () => void reload() : undefined} />}

      {loading ? (
        <TableSkeleton rows={8} />
      ) : error && rows.length === 0 ? null : rows.length === 0 ? (
        <EmptyState
          icon={<ReceiptLongRounded sx={{ fontSize: 40 }} />}
          title="ไม่พบธุรกรรมในเงื่อนไขนี้"
          description="ลองเปลี่ยนเดือนหรือล้างตัวกรองเพิ่มเติม"
        />
      ) : (
        <>
          <TransactionTable rows={rows} showRunningBalance={Boolean(bankAccountId)} onRowClick={setSelectedTxnId} busy={refreshing} />
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

      <ReviewDrawer
        txnId={selectedTxnId}
        categories={categories}
        taxEntities={taxEntities}
        onClose={() => setSelectedTxnId(null)}
        onSaved={() => void reload(true)}
        onNotice={setNotice}
      />
      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
