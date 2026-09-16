import { useEffect, useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { patch, post, req, type Account, type IncomeRecord, type TxnDetail } from '../api.js';
import Modal from '../Modal.js';
import { formatBaht, parseBahtToSatang } from '../format.js';
import Money from './Money.js';

// สร้าง/แก้ไข "รายได้เต็ม" (income_record) ได้จากทุกที่ที่ผู้ใช้อยู่ ไม่ต้องข้ามไปหน้าวางแผน:
//   - จากธุรกรรม (txn) — ยอด/บัญชี/วันที่ prefill มาให้เฉย ๆ ไม่ได้สร้างสายผูกกับเงินเข้าก้อนนั้น
//   - กรอกเอง — สำหรับรายได้ที่ไม่มีเงินเข้าบัญชีให้จับคู่ เช่น เงินสด
//   - แก้ไขของเดิม (incomeRecordId) — เผื่อใส่ยอดก่อนหักผิด
//
// ยอดเต็มคือยอดก่อนหัก ธนาคารเห็นแค่ยอดหลังหัก (ADR-0002 ข้อ 5) จึงต้องให้ผู้ใช้ยืนยันเอง
// ไม่มี endpoint ใหม่: ใช้ POST/PATCH /api/income-records เดิม
//
// กดซ้ำจากเงินเข้าก้อนเดิมได้หลายครั้ง ไม่มีอะไรกัน — รายได้ไม่ผูกกับ statement แล้ว ตรวจซ้ำเองจาก
// ตาราง "รายได้และรายการหัก" หรือ drill-down รายตัวในหน้าภาษี
type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** มา = โหมด "จากธุรกรรมนี้" (ล็อกบัญชี/วันที่ตามธุรกรรม), ไม่มา = โหมดกรอกเอง */
  txn?: TxnDetail;
  /** มา = โหมดแก้ไขรายได้ที่บันทึกไว้แล้ว (ต้องมาคู่กับ month เพื่อโหลดค่าเดิม) */
  incomeRecordId?: number;
  month?: string;
  /** ใช้เฉพาะโหมดกรอกเอง — ให้เลือกบัญชีรับเงินได้ (ไม่บังคับ) */
  accounts?: Account[];
};

function amountOrNull(text: string): number | null {
  if (text.trim() === '') return 0;
  return parseBahtToSatang(text);
}

function todayInBangkok(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function sumOfType(record: IncomeRecord | null, type: string): string {
  if (!record) return '';
  const total = record.deductions.filter((d) => d.deduction_type === type).reduce((s, d) => s + d.amount_satang, 0);
  return total > 0 ? formatBaht(total) : '';
}

export default function IncomeQuickAddModal({ open, onClose, onSaved, txn, incomeRecordId, month, accounts = [] }: Props) {
  const editing = incomeRecordId != null;
  const [name, setName] = useState(txn ? 'เงินเดือน' : '');
  const [gross, setGross] = useState(txn ? formatBaht(txn.amount_satang) : '');
  const [incomeDate, setIncomeDate] = useState(txn ? txn.txn_date : todayInBangkok());
  const [accountId, setAccountId] = useState(txn ? String(txn.bank_account_id) : '');
  const [socialSecurity, setSocialSecurity] = useState('');
  const [withholding, setWithholding] = useState('');
  const [existing, setExisting] = useState<IncomeRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // โหมดแก้ไข: ดึงค่าเดิมมาเติมฟอร์ม (ไม่มี GET /income-records/:id — ดึงทั้งเดือนแล้วหาเอา)
  useEffect(() => {
    if (!editing || !month) return;
    let current = true;
    setLoading(true);
    req<{ rows: IncomeRecord[] }>(`/api/income-records?month=${month}`)
      .then((data) => {
        if (!current) return;
        const row = data.rows.find((r) => r.id === incomeRecordId) ?? null;
        setExisting(row);
        if (row) {
          setName(row.name);
          setGross(formatBaht(row.gross_amount_satang));
          setIncomeDate(row.income_date ?? todayInBangkok());
          setAccountId(row.bank_account_id == null ? '' : String(row.bank_account_id));
          setSocialSecurity(sumOfType(row, 'social_security'));
          setWithholding(sumOfType(row, 'withholding_tax'));
        }
      })
      .catch((e: Error) => { if (current) setError(e.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [editing, incomeRecordId, month]);

  const grossSatang = amountOrNull(gross);
  const ssSatang = amountOrNull(socialSecurity);
  const whSatang = amountOrNull(withholding);
  const netSatang = grossSatang == null || ssSatang == null || whSatang == null ? null : grossSatang - ssSatang - whSatang;

  const save = async () => {
    if (grossSatang == null || ssSatang == null || whSatang == null || netSatang == null) {
      setError('กรอกจำนวนเงินให้ถูกต้อง ไม่เกิน 2 ตำแหน่งทศนิยม');
      return;
    }
    if (netSatang < 0) {
      setError('ยอดหักรวมมากกว่ายอดเต็ม');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // รายการหักประเภทอื่น (เช่น 'other' ที่เพิ่มไว้จากหน้าวางแผน) ส่งกลับไปตามเดิม ไม่ให้หายไปเงียบ ๆ
      const preserved = (existing?.deductions ?? [])
        .filter((d) => d.deduction_type !== 'social_security' && d.deduction_type !== 'withholding_tax')
        .map((d) => ({
          deduction_type: d.deduction_type,
          name: d.name,
          amount_satang: d.amount_satang,
          monthly_plan_item_id: d.monthly_plan_item_id,
        }));
      const deductions = [
        ...(ssSatang > 0 ? [{ deduction_type: 'social_security', name: 'ประกันสังคม', amount_satang: ssSatang }] : []),
        ...(whSatang > 0 ? [{ deduction_type: 'withholding_tax', name: 'ภาษีหัก ณ ที่จ่าย', amount_satang: whSatang }] : []),
        ...preserved,
      ];

      if (editing) {
        // ไม่แตะบัญชี/วันที่ตอนแก้ไข — สองอย่างนั้นผูกกับเงินเข้าที่จับคู่ไว้แล้ว
        await patch(`/api/income-records/${incomeRecordId}`, { name, gross_amount_satang: grossSatang, deductions });
      } else {
        await post('/api/income-records', {
          month: incomeDate.slice(0, 7),
          name,
          gross_amount_satang: grossSatang,
          bank_account_id: accountId === '' ? null : Number(accountId),
          income_date: incomeDate,
          deductions,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกรายได้เต็มไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  const title = editing ? 'แก้ไขรายได้เต็ม' : txn ? 'บันทึกเป็นรายได้เต็ม' : 'เพิ่มรายได้เต็มเอง';

  return (
    <Modal open={open} title={title} onClose={onClose} busy={busy}>
      <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Typography variant="body2" color="text.secondary">
          ภาษีต้องใช้ยอด "ก่อนหัก" — ถ้าสลิปเงินเดือนมีหักประกันสังคม/ภาษี ณ ที่จ่าย ให้กรอกเพิ่มด้วย
          {txn && <> ยอดที่เข้าบัญชีจริงคือ <Money satang={txn.amount_satang} /> ซึ่งเป็นยอดหลังหักแล้ว</>}
        </Typography>
        <TextField label="ชื่อรายได้" required value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น เงินเดือน" disabled={loading} />
        <TextField
          label="ยอดเต็มก่อนหัก (บาท)" required value={gross} onChange={(e) => setGross(e.target.value)}
          disabled={loading}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        <TextField
          label="วันที่รับเงิน" type="date" required value={incomeDate} onChange={(e) => setIncomeDate(e.target.value)}
          disabled={txn != null || editing}
          slotProps={{ inputLabel: { shrink: true } }}
          helperText={txn != null ? 'ตามวันที่ของธุรกรรม' : editing ? 'แก้วันที่/บัญชีได้ที่หน้าวางแผน' : undefined}
        />
        {txn == null && !editing && (
          <TextField
            select label="บัญชีรับเงิน (ไม่บังคับ)" value={accountId} onChange={(e) => setAccountId(e.target.value)}
            helperText="ไว้อ้างอิงว่าเงินเข้าบัญชีไหน"
          >
            <MenuItem value="">ไม่ระบุ (เช่น เงินสด)</MenuItem>
            {accounts.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.nickname}</MenuItem>)}
          </TextField>
        )}
        <TextField
          label="ประกันสังคม (บาท, ไม่บังคับ)" value={socialSecurity} onChange={(e) => setSocialSecurity(e.target.value)}
          disabled={loading}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        <TextField
          label="ภาษีหัก ณ ที่จ่าย (บาท, ไม่บังคับ)" value={withholding} onChange={(e) => setWithholding(e.target.value)}
          disabled={loading}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        {netSatang != null && (
          <Typography aria-live="polite">
            ยอดสุทธิหลังหัก: <Money satang={netSatang} tone={netSatang < 0 ? 'expense' : 'income'} />
          </Typography>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <Button type="submit" variant="contained" disabled={busy || loading} aria-busy={busy}>
          {busy ? 'กำลังบันทึก…' : editing ? 'บันทึกการแก้ไข' : 'บันทึกรายได้เต็ม'}
        </Button>
      </Stack>
    </Modal>
  );
}
