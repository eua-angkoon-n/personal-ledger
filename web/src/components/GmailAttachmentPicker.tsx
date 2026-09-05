import { useState } from 'react';
import { Alert, Button, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Stack, TextField, Typography } from '@mui/material';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import { post, req, type EmailAccount, type GmailAttachmentCandidate, type TaxEntity } from '../api.js';
import Modal from '../Modal.js';
import { EmptyState, LoadError, type Notice } from '../ui.js';
import { EMPTY_TAX_DOC_META_FORM, TaxDocumentMetadataFields, taxDocumentMetaPayload } from './TaxDocumentMetadataFields.js';

type Props = {
  open: boolean;
  mailboxes: EmailAccount[];
  taxEntities: TaxEntity[];
  onClose: () => void;
  onSaved: () => void;
  onNotice: (notice: Notice) => void;
};

// สองขั้น: เลือก/ค้นหาไฟล์แนบจาก Gmail ก่อน แล้วค่อยกรอก metadata เดียวกับอัปโหลดมือ (TaxDocumentMetadataFields)
export default function GmailAttachmentPicker({ open, mailboxes, taxEntities, onClose, onSaved, onNotice }: Props) {
  const [emailAccountId, setEmailAccountId] = useState('');
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<GmailAttachmentCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GmailAttachmentCandidate | null>(null);
  const [form, setForm] = useState(EMPTY_TAX_DOC_META_FORM);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setEmailAccountId('');
    setSearch('');
    setCandidates([]);
    setError('');
    setSelected(null);
    setForm(EMPTY_TAX_DOC_META_FORM);
  };

  const searchAttachments = async () => {
    if (!emailAccountId) {
      setError('เลือกกล่องอีเมลก่อน');
      return;
    }
    setSearching(true);
    setError('');
    try {
      const q = new URLSearchParams({ email_account_id: emailAccountId });
      if (search.trim()) q.set('q', search.trim());
      setCandidates(await req<GmailAttachmentCandidate[]>(`/api/tax-documents/gmail-attachments?${q}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ค้นหาไฟล์แนบไม่สำเร็จ');
    } finally {
      setSearching(false);
    }
  };

  const submit = async () => {
    if (!selected) return;
    const result = taxDocumentMetaPayload(form);
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await post('/api/tax-documents/from-gmail', {
        ...result.payload,
        email_account_id: selected.email_account_id,
        gmail_message_id: selected.gmail_message_id,
        gmail_attachment_id: selected.gmail_attachment_id,
        filename: selected.filename,
      });
      onNotice({ message: 'นำเข้าเอกสารภาษีจาก Gmail แล้ว', severity: 'success' });
      reset();
      onClose();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'นำเข้าไม่สำเร็จ');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="เลือกไฟล์แนบจาก Gmail" onClose={() => { reset(); onClose(); }} busy={submitting}>
      {!selected ? (
        <Stack spacing={2.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select label="กล่องอีเมล" value={emailAccountId} onChange={(e) => setEmailAccountId(e.target.value)} sx={{ minWidth: 200 }}>
              <MenuItem value=""><em>— เลือก —</em></MenuItem>
              {mailboxes.map((m) => <MenuItem key={m.id} value={m.id}>{m.email}</MenuItem>)}
            </TextField>
            <TextField
              label="ค้นหา (ไม่บังคับ)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void searchAttachments(); }}
              sx={{ flexGrow: 1 }}
            />
            <Button variant="outlined" startIcon={<SearchRounded />} onClick={() => void searchAttachments()} disabled={searching} aria-busy={searching} sx={{ whiteSpace: 'nowrap' }}>
              ค้นหา
            </Button>
          </Stack>

          {error && <LoadError message={error} />}

          {candidates.length === 0 ? (
            <EmptyState
              icon={<AttachFileRounded sx={{ fontSize: 40 }} />}
              title="ยังไม่มีผลค้นหา"
              description="เลือกกล่องอีเมลแล้วกดค้นหาเพื่อดูไฟล์แนบล่าสุดที่มี attachment"
            />
          ) : (
            <List dense>
              {candidates.map((c) => (
                <ListItemButton key={`${c.gmail_message_id}-${c.gmail_attachment_id}`} onClick={() => setSelected(c)}>
                  <ListItemIcon><AttachFileRounded /></ListItemIcon>
                  <ListItemText primary={c.filename} secondary={`${c.mime_type} · ${(c.size / 1024).toFixed(0)} KB`} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Stack>
      ) : (
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">ไฟล์ที่เลือก: {selected.filename}</Typography>
          <TaxDocumentMetadataFields form={form} setForm={setForm} taxEntities={taxEntities} />
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
            <Button type="button" color="inherit" onClick={() => setSelected(null)} disabled={submitting}>ย้อนกลับ</Button>
            <Button variant="contained" onClick={() => void submit()} disabled={submitting} aria-busy={submitting}>
              {submitting ? 'กำลังนำเข้า…' : 'นำเข้าเอกสาร'}
            </Button>
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}
