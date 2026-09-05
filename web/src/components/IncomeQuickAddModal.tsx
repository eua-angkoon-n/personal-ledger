import { useState } from 'react';
import { Alert, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { post, type Account, type TxnDetail } from '../api.js';
import Modal from '../Modal.js';
import { formatBaht, parseBahtToSatang } from '../format.js';
import Money from './Money.js';

// สร้าง "รายได้เต็ม" (income_record) ได้สองทาง:
//   - จากธุรกรรมที่เปิดดูอยู่ (txn) — ยอด/บัญชี/วันที่ prefill มาให้ ผู้ใช้ไม่ต้องพิมพ์ซ้ำ
//   - กรอกเอง (ไม่มี txn) — สำหรับรายได้ที่ไม่มีเงินเข้าบัญชีให้จับคู่ เช่น เงินสด หรือบัญชีที่ไม่ได้ import
//
// ยอดเต็มคือยอดก่อนหัก ธนาคารเห็นแค่ยอดหลังหัก (ADR-0002 ข้อ 5) จึงต้องให้ผู้ใช้ยืนยันเอง
// ไม่มี endpoint ใหม่: POST /api/income-records เดิมสร้าง monthly_plan ให้เองถ้ายังไม่มี และเรียก
// reconcileIncome ท้ายสุดอยู่แล้ว ยอดที่ตรงกันจึงถูกจับคู่กับเงินเข้าอัตโนมัติ
type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** มา = โหมด "จากธุรกรรมนี้" (ล็อกบัญชี/วันที่ตามธุรกรรม), ไม่มา = โหมดกรอกเอง */
  txn?: TxnDetail;
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

export default function IncomeQuickAddModal({ open, onClose, onCreated, txn, accounts = [] }: Props) {
  const [name, setName] = useState(txn ? 'เงินเดือน' : '');
  const [gross, setGross] = useState(txn ? formatBaht(txn.amount_satang) : '');
  const [incomeDate, setIncomeDate] = useState(txn ? txn.txn_date : todayInBangkok());
  const [accountId, setAccountId] = useState(txn ? String(txn.bank_account_id) : '');
  const [socialSecurity, setSocialSecurity] = useState('');
  const [withholding, setWithholding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const grossSatang = amountOrNull(gross);
  const ssSatang = amountOrNull(socialSecurity);
  const whSatang = amountOrNull(withholding);
  const netSatang = grossSatang == null || ssSatang == null || whSatang == null ? null : grossSatang - ssSatang - whSatang;
  const matchesDeposit = txn == null || netSatang === txn.amount_satang;

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
      const deductions = [
        ...(ssSatang > 0 ? [{ deduction_type: 'social_security', name: 'ประกันสังคม', amount_satang: ssSatang }] : []),
        ...(whSatang > 0 ? [{ deduction_type: 'withholding_tax', name: 'ภาษีหัก ณ ที่จ่าย', amount_satang: whSatang }] : []),
      ];
      await post('/api/income-records', {
        month: incomeDate.slice(0, 7),
        name,
        gross_amount_satang: grossSatang,
        bank_account_id: accountId === '' ? null : Number(accountId),
        income_date: incomeDate,
        // ไม่มีบัญชีก็ไม่มีอะไรให้จับคู่ — ปิด auto_match ไม่งั้นค้างสถานะ "รอ statement" ตลอดไป
        auto_match: accountId !== '',
        deductions,
        // ผูกกับเงินเข้าก้อนที่ผู้ใช้กดมาโดยตรง — ฝั่ง API ใช้ตัวนี้กันบันทึกธุรกรรมเดิมซ้ำด้วย
        ...(txn ? { source_txn_id: txn.id } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'บันทึกรายได้เต็มไม่สำเร็จ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={txn ? 'บันทึกเป็นรายได้เต็ม' : 'เพิ่มรายได้เต็มเอง'} onClose={onClose} busy={busy}>
      <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Typography variant="body2" color="text.secondary">
          ภาษีต้องใช้ยอด "ก่อนหัก" — ถ้าสลิปเงินเดือนมีหักประกันสังคม/ภาษี ณ ที่จ่าย ให้กรอกเพิ่มด้วย
          {txn && <> ระบบจะจับคู่กับเงินเข้ารายการนี้ (<Money satang={txn.amount_satang} />) ให้เอง</>}
        </Typography>
        <TextField label="ชื่อรายได้" required value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น เงินเดือน" />
        <TextField
          label="ยอดเต็มก่อนหัก (บาท)" required value={gross} onChange={(e) => setGross(e.target.value)}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        <TextField
          label="วันที่รับเงิน" type="date" required value={incomeDate} onChange={(e) => setIncomeDate(e.target.value)}
          disabled={txn != null}
          slotProps={{ inputLabel: { shrink: true } }}
          helperText={txn != null ? 'ตามวันที่ของธุรกรรม' : undefined}
        />
        {txn == null && (
          <TextField
            select label="บัญชีรับเงิน (ไม่บังคับ)" value={accountId} onChange={(e) => setAccountId(e.target.value)}
            helperText="เลือกบัญชีไว้ ระบบจะจับคู่กับเงินเข้าจริงให้เองเมื่อยอดตรงกัน"
          >
            <MenuItem value="">ไม่ระบุ (เช่น เงินสด)</MenuItem>
            {accounts.map((a) => <MenuItem key={a.id} value={String(a.id)}>{a.nickname}</MenuItem>)}
          </TextField>
        )}
        <TextField
          label="ประกันสังคม (บาท, ไม่บังคับ)" value={socialSecurity} onChange={(e) => setSocialSecurity(e.target.value)}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        <TextField
          label="ภาษีหัก ณ ที่จ่าย (บาท, ไม่บังคับ)" value={withholding} onChange={(e) => setWithholding(e.target.value)}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
        {netSatang != null && (
          <Typography aria-live="polite">
            เงินเข้าสุทธิที่คาดไว้: <Money satang={netSatang} tone={netSatang < 0 ? 'expense' : 'income'} />
          </Typography>
        )}
        {txn != null && netSatang != null && !matchesDeposit && (
          <Alert severity="warning">
            ยอดสุทธิไม่ตรงกับเงินที่เข้าบัญชีจริง — บันทึกได้ แต่ระบบจะยังไม่จับคู่ให้อัตโนมัติ
            (ยอดเต็ม − รายการหัก ต้องเท่ากับ <Money satang={txn.amount_satang} /> ถึงจะจับคู่เอง)
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        <Button type="submit" variant="contained" disabled={busy} aria-busy={busy}>
          {busy ? 'กำลังบันทึก…' : 'บันทึกรายได้เต็ม'}
        </Button>
      </Stack>
    </Modal>
  );
}
