import { Box, MenuItem, TextField } from '@mui/material';
import type { Dispatch, SetStateAction } from 'react';
import { type TaxDocumentType, type TaxEntity } from '../api.js';
import { createFormFieldChangeHandler } from '../form.js';
import { parseBahtToSatang } from '../format.js';
import { DOCUMENT_TYPE_LABEL } from '../taxDocumentLabels.js';

export type TaxDocumentMetaForm = {
  tax_entity_id: string;
  document_type: TaxDocumentType;
  tax_year: string;
  issuer_name: string;
  issuer_tax_id: string;
  document_no: string;
  issue_date: string;
  subtotal_baht: string;
  vat_baht: string;
  total_baht: string;
  withholding_baht: string;
};

export const EMPTY_TAX_DOC_META_FORM: TaxDocumentMetaForm = {
  tax_entity_id: '',
  document_type: 'receipt',
  // DB เก็บ tax_year แบบ ค.ศ. ล้วน (migration 009: check between 2000-2200 ตรงกับปีปัจจุบัน ~2026 ไม่ใช่ พ.ศ. ~2569)
  // เหมือนวันที่อื่นทั้งแอป (formatDate แสดงผลเป็น พ.ศ./ไทยแต่เก็บ ISO ค.ศ. เสมอ) — ห้ามบวก 543 ตรงนี้
  tax_year: String(new Date().getFullYear()),
  issuer_name: '',
  issuer_tax_id: '',
  document_no: '',
  issue_date: '',
  subtotal_baht: '',
  vat_baht: '',
  total_baht: '',
  withholding_baht: '',
};

// ใช้ร่วมกันระหว่าง TaxDocumentUploadModal (อัปโหลดมือ) และ GmailAttachmentPicker (เลือกจาก Gmail) —
// สอง flow ต่างกันแค่ที่มาของไฟล์ metadata ที่ต้องกรอกเหมือนกันทุกตัว
export function TaxDocumentMetadataFields({
  form, setForm, taxEntities,
}: {
  form: TaxDocumentMetaForm;
  setForm: Dispatch<SetStateAction<TaxDocumentMetaForm>>;
  taxEntities: TaxEntity[];
}) {
  const setFormField = createFormFieldChangeHandler(setForm);
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 14rem), 1fr))' }}>
      <TextField select label="Tax Entity" value={form.tax_entity_id} onChange={setFormField('tax_entity_id')} required>
        <MenuItem value=""><em>— เลือก —</em></MenuItem>
        {taxEntities.map((e) => <MenuItem key={e.id} value={e.id}>{e.display_name}</MenuItem>)}
      </TextField>
      <TextField select label="ประเภทเอกสาร" value={form.document_type} onChange={setFormField('document_type')} required>
        {(Object.entries(DOCUMENT_TYPE_LABEL) as [TaxDocumentType, string][]).map(([value, label]) => (
          <MenuItem key={value} value={value}>{label}</MenuItem>
        ))}
      </TextField>
      <TextField label="ปีภาษี (ค.ศ.)" value={form.tax_year} onChange={setFormField('tax_year')} required slotProps={{ htmlInput: { inputMode: 'numeric' } }} />
      <TextField label="ผู้ออกเอกสาร" value={form.issuer_name} onChange={setFormField('issuer_name')} required slotProps={{ htmlInput: { maxLength: 200 } }} />
      <TextField label="เลขผู้เสียภาษีผู้ออก (ไม่บังคับ)" value={form.issuer_tax_id} onChange={setFormField('issuer_tax_id')} slotProps={{ htmlInput: { maxLength: 20 } }} />
      <TextField label="เลขที่เอกสาร (ไม่บังคับ)" value={form.document_no} onChange={setFormField('document_no')} slotProps={{ htmlInput: { maxLength: 100 } }} />
      <TextField label="วันที่ออกเอกสาร (ไม่บังคับ)" type="date" value={form.issue_date} onChange={setFormField('issue_date')} slotProps={{ inputLabel: { shrink: true } }} />
      <TextField label="ยอดก่อนภาษี (บาท, ไม่บังคับ)" value={form.subtotal_baht} onChange={setFormField('subtotal_baht')} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      <TextField label="ภาษีมูลค่าเพิ่ม (บาท, ไม่บังคับ)" value={form.vat_baht} onChange={setFormField('vat_baht')} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      <TextField label="ยอดรวม (บาท)" value={form.total_baht} onChange={setFormField('total_baht')} required slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
      <TextField label="ภาษีหัก ณ ที่จ่าย (บาท, ไม่บังคับ)" value={form.withholding_baht} onChange={setFormField('withholding_baht')} slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
    </Box>
  );
}

export function taxDocumentMetaPayload(form: TaxDocumentMetaForm): { error: string } | { error: null; payload: Record<string, unknown> } {
  if (!form.tax_entity_id) return { error: 'เลือก Tax Entity' };
  const totalSatang = parseBahtToSatang(form.total_baht);
  if (totalSatang == null) return { error: 'ยอดรวมไม่ถูกต้อง' };
  const taxYear = Number(form.tax_year);
  if (!Number.isInteger(taxYear)) return { error: 'ปีภาษีไม่ถูกต้อง' };
  if (!form.issuer_name.trim()) return { error: 'กรอกชื่อผู้ออกเอกสาร' };

  return {
    error: null,
    payload: {
      tax_entity_id: Number(form.tax_entity_id),
      document_type: form.document_type,
      tax_year: taxYear,
      issuer_name: form.issuer_name,
      issuer_tax_id: form.issuer_tax_id || null,
      document_no: form.document_no || null,
      issue_date: form.issue_date || null,
      subtotal_satang: form.subtotal_baht ? parseBahtToSatang(form.subtotal_baht) : null,
      vat_satang: form.vat_baht ? parseBahtToSatang(form.vat_baht) : null,
      total_satang: totalSatang,
      withholding_satang: form.withholding_baht ? parseBahtToSatang(form.withholding_baht) : null,
    },
  };
}
