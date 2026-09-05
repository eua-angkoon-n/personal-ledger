import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  FormLabel,
  Link,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import ArchiveOutlined from '@mui/icons-material/ArchiveOutlined';
import EditRounded from '@mui/icons-material/EditRounded';
import { del, patch, post, req, type Account, type Bank, type EmailAccount, type TaxEntity, type TaxEntityType } from './api.js';
import { createFormFieldChangeHandler } from './form.js';
import Modal from './Modal.js';
import { TAX_ENTITY_TYPE_LABEL } from './taxDocumentLabels.js';
import { dataTextSx, descriptionSx } from './theme.js';
import { ConfirmDialog, EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from './ui.js';

const EMPTY = {
  bank_id: '', email_account_id: '', nickname: '', account_number: '', pdf_password: '', promptpay_id: '',
  default_tax_entity_id: '',
};

const EMPTY_ENTITY = { entity_type: 'individual' as TaxEntityType, display_name: '', tax_id: '', vat_registered: false };

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [mailboxes, setMailboxes] = useState<EmailAccount[]>([]);
  const [taxEntities, setTaxEntities] = useState<TaxEntity[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const [entityForm, setEntityForm] = useState(EMPTY_ENTITY);
  const [entityEditingId, setEntityEditingId] = useState<number | null>(null);
  const [entityModalOpen, setEntityModalOpen] = useState(false);
  const [entitySubmitting, setEntitySubmitting] = useState(false);
  const [entityError, setEntityError] = useState('');
  const addEntityButtonRef = useRef<HTMLButtonElement>(null);

  const reload = async () => {
    setLoading(true);
    setError('');
    const [accountsResult, banksResult, mailboxesResult, entitiesResult] = await Promise.allSettled([
        req<Account[]>('/api/accounts'),
        req<Bank[]>('/api/banks'),
        req<EmailAccount[]>('/api/email-accounts'),
        req<TaxEntity[]>('/api/tax-entities'),
    ]);
    const failures: string[] = [];
    if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
    else failures.push(accountsResult.reason instanceof Error ? accountsResult.reason.message : 'โหลดข้อมูลบัญชีไม่สำเร็จ');
    if (banksResult.status === 'fulfilled') setBanks(banksResult.value);
    else failures.push(banksResult.reason instanceof Error ? banksResult.reason.message : 'โหลดข้อมูลธนาคารไม่สำเร็จ');
    if (mailboxesResult.status === 'fulfilled') setMailboxes(mailboxesResult.value);
    else failures.push(mailboxesResult.reason instanceof Error ? mailboxesResult.reason.message : 'โหลดข้อมูลกล่องอีเมลไม่สำเร็จ');
    if (entitiesResult.status === 'fulfilled') setTaxEntities(entitiesResult.value);
    else failures.push(entitiesResult.reason instanceof Error ? entitiesResult.reason.message : 'โหลดข้อมูล Tax Entity ไม่สำเร็จ');
    setError(failures.join(' • '));
    setLoading(false);
  };
  useEffect(() => { void reload(); }, []);

  const setFormField = createFormFieldChangeHandler(setForm);
  const setEntityFormField = createFormFieldChangeHandler(setEntityForm);

  const openAdd = () => {
    setEditingId(null);
    setForm(EMPTY);
    setError('');
    setModalOpen(true);
  };

  const openEdit = (account: Account) => {
    setEditingId(account.id);
    setForm({
      bank_id: String(account.bank_id),
      email_account_id: String(account.email_account_id),
      nickname: account.nickname,
      account_number: account.account_number,
      pdf_password: '',
      promptpay_id: account.promptpay_id ?? '',
      default_tax_entity_id: account.default_tax_entity_id == null ? '' : String(account.default_tax_entity_id),
    });
    setError('');
    setModalOpen(true);
  };

  const openAddEntity = () => {
    setEntityEditingId(null);
    setEntityForm(EMPTY_ENTITY);
    setEntityError('');
    setEntityModalOpen(true);
  };

  const openEditEntity = (entity: TaxEntity) => {
    setEntityEditingId(entity.id);
    setEntityForm({ entity_type: entity.entity_type, display_name: entity.display_name, tax_id: '', vat_registered: entity.vat_registered });
    setEntityError('');
    setEntityModalOpen(true);
  };

  const toggleEntityActive = async (entity: TaxEntity) => {
    try {
      await patch(`/api/tax-entities/${entity.id}`, { is_active: !entity.is_active });
      await reload();
    } catch (e) {
      setNotice({ message: e instanceof Error ? e.message : 'เปลี่ยนสถานะไม่สำเร็จ', severity: 'error' });
    }
  };

  return (
    <Box>
      <PageHeader
        level={1}
        id="accounts-heading"
        title="บัญชีธนาคารของฉัน"
        description="จัดการบัญชีและกล่องอีเมลที่ระบบใช้รับข้อมูลจาก statement"
        action={<Button ref={addButtonRef} variant="contained" startIcon={<AddRounded />} onClick={openAdd} sx={{ whiteSpace: 'nowrap' }}>เพิ่มบัญชี</Button>}
      />

      {error && !modalOpen && (
        <LoadError message={error} onRetry={accounts.length === 0 ? () => void reload() : undefined} />
      )}

      {loading ? (
        <TableSkeleton />
      ) : error && accounts.length === 0 ? null
      : accounts.length === 0 ? (
        <EmptyState
          icon={<AccountBalanceRounded sx={{ fontSize: 40 }} />}
          title="ยังไม่มีบัญชีธนาคาร"
          description="เพิ่มบัญชีและเลือกกล่องอีเมลที่รับ statement เพื่อเริ่มนำเข้ารายการโดยอัตโนมัติ"
          action={<Button variant="contained" startIcon={<AddRounded />} onClick={openAdd}>เพิ่มบัญชีแรก</Button>}
        />
      ) : (
        <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 3 }}>
          <Table size="small" aria-label="บัญชีธนาคารของฉัน" sx={{ minWidth: 780 }}>
            <TableHead>
              <TableRow>
                <TableCell>ชื่อเล่น</TableCell>
                <TableCell>ธนาคาร</TableCell>
                <TableCell>เลขที่บัญชี</TableCell>
                <TableCell>กล่องอีเมล</TableCell>
                <TableCell align="right">จัดการ</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.map((account) => (
                <TableRow key={account.id} hover>
                  <TableCell>{account.nickname}</TableCell>
                  <TableCell>{account.bank_name}</TableCell>
                  <TableCell><code>{account.account_number}</code></TableCell>
                  <TableCell><code>{account.email}</code></TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                      <Button size="small" variant="outlined" startIcon={<EditRounded />} onClick={() => openEdit(account)}>แก้ไข</Button>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<ArchiveOutlined />}
                        onClick={() => setDeletingAccount(account)}
                      >
                        เก็บเข้าคลัง
                      </Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Modal open={modalOpen} title={editingId ? 'แก้ไขบัญชีธนาคาร' : 'เพิ่มบัญชีธนาคาร'} onClose={() => setModalOpen(false)} busy={submitting}>
        <Box
          component="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            setSubmitting(true);
            try {
              if (editingId) await patch(`/api/accounts/${editingId}`, form);
              else await post('/api/accounts', form);
              setModalOpen(false);
              setNotice({ message: editingId ? 'บันทึกการแก้ไขบัญชีแล้ว' : 'เพิ่มบัญชีธนาคารแล้ว', severity: 'success' });
              await reload();
            } catch (submitError) {
              setError(submitError instanceof Error ? submitError.message : 'บันทึกไม่สำเร็จ');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Stack spacing={2.5}>
            <Box>
              <Typography color="text.secondary" sx={descriptionSx}>
                ก่อนเพิ่มบัญชี ให้ขอ statement ย้อนหลังจากธนาคารส่งเข้ากล่องอีเมลของคุณ ระบบจะใช้เป็นข้อมูลตั้งต้น
              </Typography>
              <Link href="/auth/google?add=1" sx={{ display: 'inline-block', mt: 1 }}>+ ต่อกล่องอีเมลอื่นเพิ่ม</Link>
            </Box>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>การเชื่อมต่อ statement</FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
                <TextField select label="ธนาคาร" helperText="เลือกธนาคารเจ้าของบัญชี" value={form.bank_id} onChange={setFormField('bank_id')} required autoFocus>
                  <MenuItem value=""><em>— เลือก —</em></MenuItem>
                  {banks.filter((bank) => bank.is_active || String(bank.id) === form.bank_id).map((bank) => (
                    <MenuItem key={bank.id} value={bank.id}>{bank.name}</MenuItem>
                  ))}
                </TextField>
                <TextField select label="กล่องอีเมลที่ให้ระบบเข้าไปอ่าน" helperText="กล่องอีเมลที่รับ statement ของบัญชีนี้" value={form.email_account_id} onChange={setFormField('email_account_id')} required>
                  <MenuItem value=""><em>— เลือก —</em></MenuItem>
                  {mailboxes.map((mailbox) => <MenuItem key={mailbox.id} value={mailbox.id}>{mailbox.email}</MenuItem>)}
                </TextField>
              </Box>
            </Box>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>รายละเอียดบัญชี</FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
                <TextField label="ชื่อเล่น" helperText="ชื่อที่ช่วยให้จำบัญชีนี้ได้ง่าย" value={form.nickname} onChange={setFormField('nickname')} required slotProps={{ htmlInput: { maxLength: 60 } }} />
                <TextField label="เลขที่บัญชี" helperText="กรอกตามที่แสดงใน statement" value={form.account_number} onChange={setFormField('account_number')} required slotProps={{ htmlInput: { maxLength: 40 } }} />
                <TextField
                  type="password"
                  label="รหัสผ่านเปิดไฟล์ statement"
                  helperText={editingId ? 'เว้นว่างเพื่อใช้รหัสเดิม' : 'ใช้สำหรับเปิดไฟล์ PDF ที่ธนาคารส่งมา'}
                  value={form.pdf_password}
                  onChange={setFormField('pdf_password')}
                  required={!editingId}
                  autoComplete="off"
                />
                <TextField label="พร้อมเพย์ (ไม่บังคับ)" helperText="ใช้ช่วยจับคู่รายการโอนภายในครอบครัว" value={form.promptpay_id} onChange={setFormField('promptpay_id')} slotProps={{ htmlInput: { maxLength: 40 } }} />
                <TextField
                  select
                  label="Tax Entity เริ่มต้น (ไม่บังคับ)"
                  helperText="ธุรกรรมจากบัญชีนี้จะผูกกับ Tax Entity นี้โดยอัตโนมัติ แก้เป็นรายธุรกรรมได้ทีหลัง"
                  value={form.default_tax_entity_id}
                  onChange={setFormField('default_tax_entity_id')}
                >
                  <MenuItem value=""><em>— ไม่กำหนด —</em></MenuItem>
                  {taxEntities.filter((e) => e.is_active).map((e) => <MenuItem key={e.id} value={e.id}>{e.display_name}</MenuItem>)}
                </TextField>
              </Box>
            </Box>
            <Alert severity="info" sx={descriptionSx}>
              รหัสผ่านถูกเข้ารหัส <Box component="span" sx={dataTextSx}>AES-256-GCM</Box> ก่อนบันทึก และระบบจะไม่ส่งค่ากลับมาแสดงอีก
            </Alert>
            {error && <Alert severity="error">{error}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setModalOpen(false)} disabled={submitting}>ยกเลิก</Button>
              <Button type="submit" variant="contained" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'กำลังบันทึก…' : editingId ? 'บันทึกการแก้ไข' : 'เพิ่มบัญชี'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>
      <ConfirmDialog
        open={Boolean(deletingAccount)}
        title="เก็บบัญชีธนาคารเข้าคลัง"
        description={`เก็บบัญชี “${deletingAccount?.nickname ?? ''}” เข้าคลังหรือไม่? บัญชีจะหยุดรับ statement ใหม่ แต่ประวัติ statement และรายการเดิมยังอยู่ครบ`}
        confirmLabel="เก็บเข้าคลัง"
        confirmColor="warning"
        busy={submitting}
        onClose={() => setDeletingAccount(null)}
        onConfirm={async () => {
          if (!deletingAccount) return;
          setSubmitting(true);
          try {
            await del(`/api/accounts/${deletingAccount.id}`);
            setDeletingAccount(null);
            setNotice({ message: 'เก็บบัญชีธนาคารเข้าคลังแล้ว', severity: 'success' });
            await reload();
            addButtonRef.current?.focus();
          } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : 'เก็บบัญชีเข้าคลังไม่สำเร็จ');
            setDeletingAccount(null);
          } finally {
            setSubmitting(false);
          }
        }}
      />
      <Box component="section" aria-labelledby="tax-entities-heading" sx={{ mt: 5 }}>
        <PageHeader
          level={2}
          id="tax-entities-heading"
          title="Tax Entity"
          description="แยกบุคคลธรรมดา ร้านค้า หรือบริษัท เพื่อผูกกับบัญชีธนาคารและเอกสารภาษี — หนึ่งคนมีได้หลายรายการ"
          action={<Button ref={addEntityButtonRef} variant="outlined" startIcon={<AddRounded />} onClick={openAddEntity} sx={{ whiteSpace: 'nowrap' }}>เพิ่ม Tax Entity</Button>}
        />
        {taxEntities.length === 0 && !loading ? (
          <EmptyState
            icon={<AccountBalanceRounded sx={{ fontSize: 40 }} />}
            title="ยังไม่มี Tax Entity"
            description="เพิ่ม Tax Entity เพื่อกำหนดเจ้าของเอกสารภาษีและบัญชีธนาคาร"
            action={<Button variant="outlined" startIcon={<AddRounded />} onClick={openAddEntity}>เพิ่มรายการแรก</Button>}
          />
        ) : (
          <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 3 }}>
            <Table size="small" aria-label="Tax Entity" sx={{ minWidth: 560 }}>
              <TableHead>
                <TableRow>
                  <TableCell>ชื่อ</TableCell>
                  <TableCell>ประเภท</TableCell>
                  <TableCell>VAT</TableCell>
                  <TableCell>ใช้งาน</TableCell>
                  <TableCell align="right">จัดการ</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {taxEntities.map((entity) => (
                  <TableRow key={entity.id} hover>
                    <TableCell>{entity.display_name}</TableCell>
                    <TableCell>{TAX_ENTITY_TYPE_LABEL[entity.entity_type]}</TableCell>
                    <TableCell>{entity.vat_registered ? <Chip size="small" label="จดทะเบียน" variant="outlined" /> : '—'}</TableCell>
                    <TableCell>
                      <Switch
                        size="small"
                        checked={entity.is_active}
                        onChange={() => void toggleEntityActive(entity)}
                        slotProps={{ input: { 'aria-label': `${entity.is_active ? 'ปิด' : 'เปิด'}ใช้งาน ${entity.display_name}` } }}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" variant="outlined" startIcon={<EditRounded />} onClick={() => openEditEntity(entity)}>แก้ไข</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Box>

      <Modal
        open={entityModalOpen}
        title={entityEditingId ? 'แก้ไข Tax Entity' : 'เพิ่ม Tax Entity'}
        onClose={() => setEntityModalOpen(false)}
        busy={entitySubmitting}
      >
        <Box
          component="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setEntityError('');
            setEntitySubmitting(true);
            try {
              const payload = {
                entity_type: entityForm.entity_type,
                display_name: entityForm.display_name,
                vat_registered: entityForm.vat_registered,
                ...(entityForm.tax_id ? { tax_id: entityForm.tax_id } : {}),
              };
              if (entityEditingId) await patch(`/api/tax-entities/${entityEditingId}`, payload);
              else await post('/api/tax-entities', payload);
              setEntityModalOpen(false);
              setNotice({ message: entityEditingId ? 'บันทึกการแก้ไข Tax Entity แล้ว' : 'เพิ่ม Tax Entity แล้ว', severity: 'success' });
              await reload();
            } catch (submitError) {
              setEntityError(submitError instanceof Error ? submitError.message : 'บันทึกไม่สำเร็จ');
            } finally {
              setEntitySubmitting(false);
            }
          }}
        >
          <Stack spacing={2.5}>
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))' }}>
              <TextField select label="ประเภท" value={entityForm.entity_type} onChange={setEntityFormField('entity_type')} required autoFocus>
                {(Object.entries(TAX_ENTITY_TYPE_LABEL) as [TaxEntityType, string][]).map(([value, label]) => (
                  <MenuItem key={value} value={value}>{label}</MenuItem>
                ))}
              </TextField>
              <TextField label="ชื่อ" value={entityForm.display_name} onChange={setEntityFormField('display_name')} required slotProps={{ htmlInput: { maxLength: 100 } }} />
              <TextField
                label="เลขผู้เสียภาษี (ไม่บังคับ)"
                helperText={entityEditingId ? 'เว้นว่างเพื่อใช้ค่าเดิม' : undefined}
                value={entityForm.tax_id}
                onChange={setEntityFormField('tax_id')}
                autoComplete="off"
                slotProps={{ htmlInput: { maxLength: 20 } }}
              />
            </Box>
            <FormControlLabel
              control={<Switch checked={entityForm.vat_registered} onChange={(e) => setEntityForm((f) => ({ ...f, vat_registered: e.target.checked }))} />}
              label="จดทะเบียน VAT"
            />
            <Alert severity="info" sx={descriptionSx}>
              เลขผู้เสียภาษีถูกเข้ารหัส <Box component="span" sx={dataTextSx}>AES-256-GCM</Box> ก่อนบันทึก และระบบจะไม่ส่งค่ากลับมาแสดงอีก
            </Alert>
            {entityError && <Alert severity="error">{entityError}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setEntityModalOpen(false)} disabled={entitySubmitting}>ยกเลิก</Button>
              <Button type="submit" variant="contained" disabled={entitySubmitting} aria-busy={entitySubmitting}>
                {entitySubmitting ? 'กำลังบันทึก…' : entityEditingId ? 'บันทึกการแก้ไข' : 'เพิ่ม Tax Entity'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>

      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}
