import type { ReactElement } from 'react';
import { Chip } from '@mui/material';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import EditNoteRounded from '@mui/icons-material/EditNoteRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import type { TaxDocumentStatus } from '../api.js';

// เหมือน PaymentStatusChip.tsx — theme ไม่มีสี warning และ accent สงวนไว้สำหรับ action เท่านั้น
// (Restrained Accent Rule) จึงแยกสถานะกลาง ๆ ด้วยไอคอน + label แทนสี
type Spec = { label: string; color: 'default' | 'success'; icon: ReactElement };

const SPECS: Record<TaxDocumentStatus, Spec> = {
  draft: { label: 'ฉบับร่าง', color: 'default', icon: <EditNoteRounded /> },
  verified: { label: 'ตรวจสอบแล้ว', color: 'success', icon: <CheckCircleRounded /> },
  submitted: { label: 'ยื่นแล้ว', color: 'default', icon: <SendRounded /> },
};

export default function TaxDocumentStatusChip({ status }: { status: TaxDocumentStatus }) {
  const spec = SPECS[status];
  return <Chip size="small" icon={spec.icon} label={spec.label} color={spec.color} variant="outlined" />;
}
