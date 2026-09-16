import type { ReactElement } from 'react';
import { Chip } from '@mui/material';
import BlockRounded from '@mui/icons-material/BlockRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import DonutLargeRounded from '@mui/icons-material/DonutLargeRounded';
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded';
import SkipNextRounded from '@mui/icons-material/SkipNextRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import type { PaymentState } from '../api.js';

// สถานะการจ่ายตาม §8.2 — ไม่มี "รอ statement"/"ยืนยันแล้ว" แล้ว แผนไม่ผูกกับ statement
// การจ่ายคือสิ่งที่ผู้ใช้บันทึกเอง จบที่ "จ่ายแล้ว" ส่วนรายได้จบที่ "บันทึกรายได้แล้ว"
//
// DESIGN.md มีแค่ accent/income/expense/neutral — ไม่มีสี warning และ accent สงวนไว้สำหรับ
// action/focus/selection (Restrained Accent Rule) จึงใช้ได้แค่ error (=expense) กับ success (=income)
// ที่ theme.ts นิยามไว้จริง ส่วนสถานะกลาง ๆ แยกด้วยไอคอน + label ไม่เพิ่มสีใหม่เอง
// (ท่าเดียวกับ DataFreshness.tsx) label มีครบทุกตัวจึงยังผ่าน Semantic Color Rule
type Spec = { label: string; color: 'default' | 'success' | 'error'; icon: ReactElement };

const SPECS: Record<PaymentState, Spec> = {
  deducted: { label: 'หักจากรายได้', color: 'default', icon: <CheckCircleRounded /> },
  not_required: { label: 'ไม่ต้องรับเงิน', color: 'default', icon: <CheckCircleRounded /> },
  unpaid: { label: 'ยังไม่จ่าย', color: 'default', icon: <RadioButtonUncheckedRounded /> },
  overdue: { label: 'เกินกำหนด', color: 'error', icon: <WarningAmberRounded /> },
  partial: { label: 'จ่ายบางส่วน', color: 'default', icon: <DonutLargeRounded /> },
  paid: { label: 'จ่ายแล้ว', color: 'success', icon: <CheckCircleRounded /> },
  received: { label: 'บันทึกรายได้แล้ว', color: 'success', icon: <CheckCircleRounded /> },
  skipped: { label: 'ข้ามเดือนนี้', color: 'default', icon: <SkipNextRounded /> },
  cancelled: { label: 'ยกเลิก', color: 'default', icon: <BlockRounded /> },
};

export default function PaymentStatusChip({ state }: { state: PaymentState }) {
  const spec = SPECS[state] ?? SPECS.unpaid;
  return <Chip size="small" icon={spec.icon} label={spec.label} color={spec.color} variant="outlined" />;
}
