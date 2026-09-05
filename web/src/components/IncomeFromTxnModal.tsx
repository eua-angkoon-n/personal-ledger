import { useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import { post, type TxnDetail } from '../api.js';
import Modal from '../Modal.js';
import { formatBaht, parseBahtToSatang } from '../format.js';
import Money from './Money.js';

// สร้าง "รายได้เต็ม" (income_record) จากธุรกรรมที่เปิดดูอยู่ — เดิมต้องไปพิมพ์ยอด/บัญชี/วันที่ซ้ำเองที่หน้าวางแผน
// ยอดเต็มคือยอดก่อนหัก ธนาคารเห็นแค่ยอดหลังหัก (ADR-0002 ข้อ 5) จึงต้องให้ผู้ใช้กรอกเอง แต่ prefill
// ด้วยยอดที่เข้าบัญชีจริงไว้ก่อน — คนที่ไม่มีรายการหักอะไรเลยกดบันทึกได้ทันทีโดยไม่ต้องแก้อะไร
//
// ไม่มี endpoint ใหม่: POST /api/income-records เดิมสร้าง monthly_plan ให้เองถ้ายังไม่มี และเรียก
// reconcileIncome ท้ายสุดอยู่แล้ว ยอดที่ตรงกันจึงถูกจับคู่กับธุรกรรมนี้อัตโนมัติ
type Props = {
  detail: TxnDetail;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
};

function amountOrNull(text: string): number | null {
  if (text.trim() === '') return 0;
  return parseBahtToSatang(text);
}

export default function IncomeFromTxnModal({ detail, open, onClose, onCreated }: Props) {
  const [name, setName] = useState('เงินเดือน');
  const [gross, setGross] = useState(formatBaht(detail.amount_satang));
  const [socialSecurity, setSocialSecurity] = useState('');
  const [withholding, setWithholding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const grossSatang = amountOrNull(gross);
  const ssSatang = amountOrNull(socialSecurity);
  const whSatang = amountOrNull(withholding);
  const netSatang = grossSatang == null || ssSatang == null || whSatang == null ? null : grossSatang - ssSatang - whSatang;
  const matchesDeposit = netSatang === detail.amount_satang;

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
        month: detail.txn_date.slice(0, 7),
        name,
        gross_amount_satang: grossSatang,
        bank_account_id: detail.bank_account_id,
        income_date: detail.txn_date,
        auto_match: true,
        deductions,
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
    <Modal open={open} title="บันทึกเป็นรายได้เต็ม" onClose={onClose} busy={busy}>
      <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Typography variant="body2" color="text.secondary">
          ภาษีต้องใช้ยอด "ก่อนหัก" แต่ธนาคารเห็นแค่ยอดที่เข้าบัญชีจริง ({<Money satang={detail.amount_satang} />}) —
          ถ้าสลิปเงินเดือนมีหักประกันสังคม/ภาษี ณ ที่จ่าย ให้กรอกเพิ่ม ระบบจะจับคู่กับเงินเข้ารายการนี้ให้เอง
        </Typography>
        <TextField label="ชื่อรายได้" required value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="ยอดเต็มก่อนหัก (บาท)" required value={gross} onChange={(e) => setGross(e.target.value)}
          slotProps={{ htmlInput: { inputMode: 'decimal' } }}
        />
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
        {netSatang != null && !matchesDeposit && (
          <Alert severity="warning">
            ยอดสุทธิไม่ตรงกับเงินที่เข้าบัญชีจริง — บันทึกได้ แต่ระบบจะยังไม่จับคู่ให้อัตโนมัติ
            (ยอดเต็ม − รายการหัก ต้องเท่ากับ <Money satang={detail.amount_satang} /> ถึงจะจับคู่เอง)
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
