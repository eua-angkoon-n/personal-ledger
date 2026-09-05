import { useState } from 'react';
import { Alert, Button, Stack } from '@mui/material';
import UploadFileRounded from '@mui/icons-material/UploadFileRounded';
import { post, type TaxEntity } from '../api.js';
import Modal from '../Modal.js';
import type { Notice } from '../ui.js';
import { EMPTY_TAX_DOC_META_FORM, TaxDocumentMetadataFields, taxDocumentMetaPayload } from './TaxDocumentMetadataFields.js';

type Props = {
  open: boolean;
  taxEntities: TaxEntity[];
  onClose: () => void;
  onSaved: () => void;
  onNotice: (notice: Notice) => void;
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
    reader.readAsDataURL(file);
  });
}

// ยัด base64 ใน JSON แทน multipart — ไม่เพิ่ม dependency ใหม่ ระบบมีเพดาน 15MB ต่อคำขอฝั่ง server (server.ts)
// และ 10MB ต่อไฟล์หลัง decode (route บังคับอีกชั้น)
export default function TaxDocumentUploadModal({ open, taxEntities, onClose, onSaved, onNotice }: Props) {
  const [form, setForm] = useState(EMPTY_TAX_DOC_META_FORM);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setForm(EMPTY_TAX_DOC_META_FORM);
    setFile(null);
    setError('');
  };

  const submit = async () => {
    setError('');
    if (!file) {
      setError('เลือกไฟล์ก่อน');
      return;
    }
    const result = taxDocumentMetaPayload(form);
    if (result.error !== null) {
      setError(result.error);
      return;
    }

    setSubmitting(true);
    try {
      const fileBase64 = await readAsBase64(file);
      await post('/api/tax-documents', { ...result.payload, filename: file.name, file_base64: fileBase64 });
      onNotice({ message: 'อัปโหลดเอกสารภาษีแล้ว', severity: 'success' });
      reset();
      onClose();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'อัปโหลดไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="อัปโหลดเอกสารภาษี" onClose={() => { reset(); onClose(); }} busy={submitting}>
      <Stack spacing={2.5}>
        <Button component="label" variant="outlined" startIcon={<UploadFileRounded />} sx={{ alignSelf: 'flex-start' }}>
          {file ? file.name : 'เลือกไฟล์ (PDF หรือรูป)'}
          <input type="file" accept=".pdf,image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Button>
        <TaxDocumentMetadataFields form={form} setForm={setForm} taxEntities={taxEntities} />
        {error && <Alert severity="error">{error}</Alert>}
        <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button type="button" color="inherit" onClick={() => { reset(); onClose(); }} disabled={submitting}>ยกเลิก</Button>
          <Button variant="contained" onClick={() => void submit()} disabled={submitting} aria-busy={submitting}>
            {submitting ? 'กำลังอัปโหลด…' : 'อัปโหลด'}
          </Button>
        </Stack>
      </Stack>
    </Modal>
  );
}
