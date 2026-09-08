import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormLabel,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material';
import AddRounded from '@mui/icons-material/AddRounded';
import AccountBalanceRounded from '@mui/icons-material/AccountBalanceRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import GroupRounded from '@mui/icons-material/GroupRounded';
import PowerSettingsNewRounded from '@mui/icons-material/PowerSettingsNewRounded';
import { del, patch, post, req, type Bank, type User } from './api.js';
import { createFormFieldChangeHandler } from './form.js';
import Modal from './Modal.js';
import { dataTextSx, descriptionSx } from './theme.js';
import { ConfirmDialog, EmptyState, FeedbackSnackbar, LoadError, PageHeader, TableSkeleton, type Notice } from './ui.js';

const EMPTY = {
  name: '',
  sender_email: '',
  sender_domain: '',
  subject_monthly: '',
  subject_ondemand: '',
  attachment_filename_pattern: '\\.pdf$',
  parser_key: '',
};

function Banks() {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [parserKeys, setParserKeys] = useState<string[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [togglingBankId, setTogglingBankId] = useState<number | null>(null);
  const [deletingBank, setDeletingBank] = useState<Bank | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      setBanks(await req<Bank[]>('/api/banks'));
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : 'โหลดข้อมูลธนาคารไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    req<{ keys: string[] }>('/api/admin/parser-keys').then((r) => setParserKeys(r.keys)).catch(() => {});
  }, []);

  const setFormField = createFormFieldChangeHandler(setForm);

  const openAdd = () => {
    setEditingId(null);
    setForm({ ...EMPTY, parser_key: parserKeys[0] ?? '' });
    setError('');
    setModalOpen(true);
  };

  const openEdit = (bank: Bank) => {
    setEditingId(bank.id);
    setForm({
      name: bank.name,
      sender_email: bank.sender_email,
      sender_domain: bank.sender_domain,
      subject_monthly: bank.subject_monthly,
      subject_ondemand: bank.subject_ondemand,
      attachment_filename_pattern: bank.attachment_filename_pattern,
      parser_key: bank.parser_key,
    });
    setError('');
    setModalOpen(true);
  };

  const toggleBank = async (bank: Bank) => {
    setTogglingBankId(bank.id);
    setError('');
    try {
      await patch(`/api/banks/${bank.id}`, { is_active: !bank.is_active });
      setNotice({ message: `${bank.is_active ? 'ปิด' : 'เปิด'}ใช้งาน ${bank.name} แล้ว`, severity: 'success' });
      await reload();
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : 'เปลี่ยนสถานะธนาคารไม่สำเร็จ');
    } finally {
      setTogglingBankId(null);
    }
  };

  return (
    <Box sx={{ mt: 4 }}>
      <PageHeader
        title="ธนาคารที่รองรับ"
        description="กำหนดรูปแบบอีเมลและตัวแกะข้อมูลที่ระบบใช้ตรวจ statement ของแต่ละธนาคาร"
        action={<Button ref={addButtonRef} variant="contained" startIcon={<AddRounded />} onClick={openAdd} sx={{ whiteSpace: 'nowrap' }}>เพิ่มธนาคาร</Button>}
      />

      {error && !modalOpen && (
        <LoadError message={error} onRetry={banks.length === 0 ? () => void reload() : undefined} />
      )}

      {loading ? (
        <TableSkeleton />
      ) : error && banks.length === 0 ? null
      : banks.length === 0 ? (
        <EmptyState
          icon={<AccountBalanceRounded sx={{ fontSize: 40 }} />}
          title="ยังไม่มีธนาคารที่รองรับ"
          description="เพิ่มข้อมูลผู้ส่งและรูปแบบ statement เพื่อให้ระบบตรวจสอบและนำเข้าไฟล์ได้ถูกต้อง"
          action={<Button variant="contained" startIcon={<AddRounded />} onClick={openAdd}>เพิ่มธนาคารแรก</Button>}
        />
      ) : <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 3 }}>
        <Table size="small" aria-label="ธนาคารที่รองรับ" sx={{ minWidth: 980 }}>
          <TableHead>
            <TableRow>
              <TableCell>ชื่อ</TableCell>
              <TableCell>ผู้ส่ง / โดเมน</TableCell>
              <TableCell>หัวข้อรายเดือน / ขอเอง</TableCell>
              <TableCell>สถานะปัจจุบัน</TableCell>
              <TableCell align="right">จัดการ</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {banks.map((bank) => (
              <TableRow key={bank.id} hover>
                <TableCell>{bank.name}<br /><code>{bank.parser_key}</code></TableCell>
                <TableCell><code>{bank.sender_email}</code><br /><code>{bank.sender_domain}</code></TableCell>
                <TableCell><code>{bank.subject_monthly}</code><br /><code>{bank.subject_ondemand}</code></TableCell>
                <TableCell>
                  <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <Chip size="small" color={bank.is_active ? 'success' : 'default'} label={bank.is_active ? 'เปิดใช้งานอยู่' : 'ปิดใช้งานอยู่'} />
                    <Button
                      size="small"
                      color={bank.is_active ? 'inherit' : 'success'}
                      startIcon={<PowerSettingsNewRounded />}
                      onClick={() => void toggleBank(bank)}
                      disabled={togglingBankId === bank.id}
                      aria-busy={togglingBankId === bank.id}
                    >
                      {togglingBankId === bank.id ? 'กำลังเปลี่ยน…' : bank.is_active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                    </Button>
                  </Stack>
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                    <Button size="small" variant="outlined" startIcon={<EditRounded />} onClick={() => openEdit(bank)}>แก้ไข</Button>
                      <Button
                        size="small"
                        color="error"
                        startIcon={<DeleteOutlineRounded />}
                        onClick={() => setDeletingBank(bank)}
                      >
                      ลบ
                    </Button>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>}

      <Modal open={modalOpen} title={editingId ? 'แก้ไขข้อมูลธนาคาร' : 'เพิ่มธนาคาร'} onClose={() => setModalOpen(false)} busy={submitting}>
        <Box
          component="form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            setSubmitting(true);
            try {
              if (editingId) await patch(`/api/banks/${editingId}`, form);
              else await post('/api/banks', form);
              setModalOpen(false);
              setNotice({ message: editingId ? 'บันทึกข้อมูลธนาคารแล้ว' : 'เพิ่มธนาคารแล้ว', severity: 'success' });
              await reload();
            } catch (submitError) {
              setError(submitError instanceof Error ? submitError.message : 'บันทึกไม่สำเร็จ');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Stack spacing={2.5}>
            <Alert severity="info" sx={descriptionSx}>
              อีเมลผู้ส่งต้องเป็นอีเมลของธนาคารที่ส่ง statement และโดเมนใช้ตรวจ <Box component="span" sx={dataTextSx}>DKIM</Box>
            </Alert>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>ข้อมูลธนาคาร</FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))' }}>
                <TextField label="ชื่อธนาคาร" helperText="ชื่อที่แสดงในหน้าตั้งค่าบัญชี" value={form.name} onChange={setFormField('name')} required autoFocus />
                <TextField select label="ตัวแกะข้อมูล" helperText="เลือก parser ที่ตรงกับรูปแบบ statement" value={form.parser_key} onChange={setFormField('parser_key')} required>
                  {parserKeys.map((key) => <MenuItem key={key} value={key}>{key}</MenuItem>)}
                </TextField>
              </Box>
            </Box>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>การยืนยันผู้ส่ง</FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))' }}>
                <TextField label="อีเมลผู้ส่งของธนาคาร" helperText="อีเมล From ที่ใช้ส่ง statement" value={form.sender_email} onChange={setFormField('sender_email')} required placeholder="statement@kasikornbank.com" />
                <TextField label="โดเมนผู้ส่ง (ตรวจ DKIM)" helperText="โดเมนที่ต้องผ่านการยืนยัน DKIM" value={form.sender_domain} onChange={setFormField('sender_domain')} required placeholder="kasikornbank.com" />
              </Box>
            </Box>
            <Box component="fieldset" sx={{ m: 0, p: 0, minWidth: 0, border: 0 }}>
              <FormLabel component="legend" sx={{ mb: 1.5, color: 'text.primary', fontWeight: 650 }}>รูปแบบการจับคู่ไฟล์</FormLabel>
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))' }}>
                <TextField label="หัวข้ออีเมล statement รายเดือน (regex)" helperText="Regular expression สำหรับ statement รายเดือน" value={form.subject_monthly} onChange={setFormField('subject_monthly')} required />
                <TextField label="หัวข้ออีเมล statement ที่ผู้ใช้ขอเอง (regex)" helperText="Regular expression สำหรับ statement ย้อนหลัง" value={form.subject_ondemand} onChange={setFormField('subject_ondemand')} required />
                <TextField label="ชื่อไฟล์แนบ (regex)" helperText="Regular expression สำหรับชื่อไฟล์ PDF" value={form.attachment_filename_pattern} onChange={setFormField('attachment_filename_pattern')} required />
              </Box>
            </Box>
            {error && <Alert severity="error">{error}</Alert>}
            <Stack direction={{ xs: 'column-reverse', sm: 'row' }} spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Button type="button" color="inherit" onClick={() => setModalOpen(false)} disabled={submitting}>ยกเลิก</Button>
              <Button type="submit" variant="contained" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'กำลังบันทึก…' : editingId ? 'บันทึกการแก้ไข' : 'เพิ่มธนาคาร'}
              </Button>
            </Stack>
          </Stack>
        </Box>
      </Modal>
      <ConfirmDialog
        open={Boolean(deletingBank)}
        title="ลบธนาคาร"
        description={`ลบธนาคาร “${deletingBank?.name ?? ''}” หรือไม่? การดำเนินการนี้ย้อนกลับไม่ได้`}
        confirmLabel="ลบธนาคาร"
        confirmColor="error"
        busy={submitting}
        onClose={() => setDeletingBank(null)}
        onConfirm={async () => {
          if (!deletingBank) return;
          setSubmitting(true);
          try {
            await del(`/api/banks/${deletingBank.id}`);
            setDeletingBank(null);
            setNotice({ message: 'ลบธนาคารแล้ว', severity: 'success' });
            await reload();
            addButtonRef.current?.focus();
          } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : 'ลบธนาคารไม่สำเร็จ');
            setDeletingBank(null);
          } finally {
            setSubmitting(false);
          }
        }}
      />
      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}

type PendingUserAction =
  | { kind: 'reject'; user: User }
  | { kind: 'role'; user: User; isAdmin: boolean };

function Users({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingUserId, setUpdatingUserId] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingUserAction | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(await req<User[]>('/api/admin/users'));
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : 'โหลดข้อมูลผู้ใช้ไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void reload(); }, []);

  const updateUser = async (user: User, body: { status?: User['status']; is_admin?: boolean }, successMessage: string) => {
    setUpdatingUserId(user.id);
    setError('');
    try {
      await patch(`/api/admin/users/${user.id}`, body);
      setNotice({ message: successMessage, severity: 'success' });
      await reload();
    } catch (responseError) {
      setError(responseError instanceof Error ? responseError.message : 'บันทึกข้อมูลผู้ใช้ไม่สำเร็จ');
    } finally {
      setUpdatingUserId(null);
    }
  };

  const setStatus = (user: User, status: User['status']) => {
    if (status === 'rejected') {
      setPendingAction({ kind: 'reject', user });
      return;
    }
    void updateUser(user, { status }, `เปลี่ยนสถานะของ ${user.display_name} แล้ว`);
  };

  const setRole = (user: User, isAdmin: boolean) => {
    setPendingAction({ kind: 'role', user, isAdmin });
  };

  return (
    <Box sx={{ mt: 4 }}>
      <PageHeader
        title="ผู้ใช้งาน"
        description="อนุมัติสมาชิกและกำหนดบทบาทผู้ดูแล โดยบัญชีของคุณเองจะไม่สามารถเปลี่ยนจากหน้านี้ได้"
      />
      {error && (
        <LoadError message={error} onRetry={users.length === 0 ? () => void reload() : undefined} />
      )}
      {loading ? (
        <TableSkeleton />
      ) : error && users.length === 0 ? null
      : users.length === 0 ? (
        <EmptyState
          icon={<GroupRounded sx={{ fontSize: 40 }} />}
          title="ยังไม่มีผู้ใช้งาน"
          description="สมาชิกจะปรากฏที่นี่หลังจากเข้าสู่ระบบด้วย Google รอให้แอดมินอนุมัติ"
        />
      ) : <TableContainer component={Paper} variant="outlined" tabIndex={0} sx={{ mt: 3 }}>
        <Table size="small" aria-label="ผู้ใช้งาน" sx={{ minWidth: 760 }}>
          <TableHead>
            <TableRow><TableCell>อีเมล</TableCell><TableCell>ชื่อ</TableCell><TableCell>สถานะ</TableCell><TableCell>บทบาท</TableCell></TableRow>
          </TableHead>
          <TableBody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <TableRow key={user.id} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <code>{user.email}</code>
                      {isSelf && <Chip size="small" color="primary" label="คุณ" />}
                    </Stack>
                  </TableCell>
                  <TableCell>{user.display_name}</TableCell>
                  <TableCell>
                    <TextField
                      select
                      size="small"
                      aria-label={`สถานะของ ${user.email}`}
                      value={user.status}
                      disabled={isSelf || updatingUserId !== null}
                      onChange={(event) => setStatus(user, event.target.value as User['status'])}
                      sx={{ minWidth: 150 }}
                    >
                      <MenuItem value="pending">รออนุมัติ</MenuItem>
                      <MenuItem value="approved">อนุมัติแล้ว</MenuItem>
                      <MenuItem value="rejected">ปฏิเสธ</MenuItem>
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <TextField
                      select
                      size="small"
                      aria-label={`บทบาทของ ${user.email}`}
                      value={user.is_admin ? 'admin' : 'user'}
                      disabled={isSelf || updatingUserId !== null}
                      onChange={(event) => setRole(user, event.target.value === 'admin')}
                      sx={{ minWidth: 150 }}
                    >
                      <MenuItem value="user">ผู้ใช้ทั่วไป</MenuItem>
                      <MenuItem value="admin">ผู้ดูแล</MenuItem>
                    </TextField>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>}
      <ConfirmDialog
        open={Boolean(pendingAction)}
        title={pendingAction?.kind === 'reject' ? 'ปฏิเสธการเข้าใช้งาน' : 'เปลี่ยนบทบาทผู้ใช้'}
        description={pendingAction?.kind === 'reject'
          ? `ปฏิเสธ ${pendingAction.user.email} หรือไม่? สิทธิ์เข้าถึง Gmail ของผู้ใช้นี้จะถูกยกเลิกและลบทิ้ง`
          : `เปลี่ยนบทบาทของ ${pendingAction?.user.email ?? ''} เป็น “${pendingAction?.kind === 'role' && pendingAction.isAdmin ? 'ผู้ดูแล' : 'ผู้ใช้ทั่วไป'}” หรือไม่?`}
        confirmLabel={pendingAction?.kind === 'reject' ? 'ปฏิเสธผู้ใช้' : 'เปลี่ยนบทบาท'}
        confirmColor={pendingAction?.kind === 'reject' ? 'error' : 'primary'}
        busy={updatingUserId !== null}
        onClose={() => setPendingAction(null)}
        onConfirm={async () => {
          if (!pendingAction) return;
          const action = pendingAction;
          if (action.kind === 'reject') {
            await updateUser(action.user, { status: 'rejected' }, `ปฏิเสธ ${action.user.display_name} แล้ว`);
          } else {
            await updateUser(
              action.user,
              { is_admin: action.isAdmin },
              `เปลี่ยนบทบาทของ ${action.user.display_name} เป็น${action.isAdmin ? 'ผู้ดูแล' : 'ผู้ใช้ทั่วไป'}แล้ว`,
            );
          }
          setPendingAction(null);
        }}
      />
      <FeedbackSnackbar notice={notice} onClose={() => setNotice(null)} />
    </Box>
  );
}

export default { Banks, Users };
