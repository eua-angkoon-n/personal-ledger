import { Link as RouterLink } from 'react-router-dom';
import {
  Accordion, AccordionDetails, AccordionSummary, Box, Button, Link, Paper, Stack, Typography,
} from '@mui/material';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import PrintRounded from '@mui/icons-material/PrintRounded';
import { GUIDES, HELP_ORDER } from '../guide/guides.js';
import { descriptionSx } from '../theme.js';
import { PageHeader } from '../ui.js';

/**
 * คู่มือรวมทุกหน้า — เนื้อหาชุดเดียวกับปุ่มคู่มือในแต่ละหน้า (`web/src/guide/guides.ts`)
 * ต่างกันแค่วิธีอ่าน: ที่นี่อ่านต่อเนื่องและพิมพ์ได้ ในหน้าจริงคือไฮไลต์ทีละขั้น
 *
 * ใช้ `window.print()` ตามแบบเดียวกับปุ่มพิมพ์ในหน้าภาษี ไม่เพิ่ม PDF library
 */
export default function Help() {
  return (
    <Box>
      <PageHeader
        level={1}
        id="help-heading"
        title="คู่มือการใช้งาน"
        description="อธิบายทุกหน้าตั้งแต่ตั้งค่าบัญชีธนาคารจนถึงประมาณการภาษี · ในแต่ละหน้ายังมีปุ่มคู่มือ (?) ข้างชื่อหน้า กดแล้วจะไฮไลต์ทีละขั้นบนหน้าจอจริง"
        action={
          <Button variant="outlined" startIcon={<PrintRounded />} onClick={() => window.print()} sx={{ whiteSpace: 'nowrap' }}>
            พิมพ์คู่มือ
          </Button>
        }
      />

      <Paper variant="outlined" sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
        <Typography component="h2" variant="h2">เริ่มต้นใช้งานครั้งแรก 4 ขั้น</Typography>
        <Stack component="ol" spacing={1} sx={{ mt: 1.5, pl: 3, ...descriptionSx, color: 'text.secondary' }}>
          <li>
            ไปที่ <Link component={RouterLink} to="/accounts">บัญชีของฉัน</Link> เพิ่มบัญชีธนาคาร
            พร้อมรหัสผ่านที่ใช้เปิดไฟล์ PDF ของ statement
          </li>
          <li>รอสักครู่ให้ระบบไล่อ่านอีเมลย้อนหลัง แล้วดูที่ <Link component={RouterLink} to="/dashboard">แดชบอร์ด</Link> ว่าข้อมูลเข้าครบถึงเดือนไหน</li>
          <li>ไปที่ <Link component={RouterLink} to="/transactions">ธุรกรรม</Link> จัดหมวดและยืนยันคู่โอน เพื่อให้รายงานตรงกับความจริง</li>
          <li>
            ถ้าต้องใช้เรื่องภาษี ให้เก็บใบเสร็จไว้ที่ <Link component={RouterLink} to="/tax-documents">เอกสารภาษี</Link>
            {' '}แล้วดูประมาณการที่หน้า <Link component={RouterLink} to="/tax">ภาษี</Link>
          </li>
        </Stack>
      </Paper>

      <Box sx={{ mt: 3 }}>
        {HELP_ORDER.map((path) => {
          const guide = GUIDES[path];
          if (!guide) return null;
          return (
            <Accordion key={path} disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
              <AccordionSummary expandIcon={<ExpandMoreRounded />} aria-controls={`help-${path}-content`}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography component="h2" variant="h2">{guide.title}</Typography>
                  <Typography color="text.secondary" sx={{ mt: 0.5, ...descriptionSx }}>{guide.purpose}</Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails id={`help-${path}-content`}>
                <Stack spacing={2.5}>
                  {guide.steps.map((step, i) => (
                    <Box key={i}>
                      <Typography component="h3" sx={{ fontWeight: 650 }}>{step.title}</Typography>
                      <Typography color="text.secondary" sx={{ mt: 0.5, maxWidth: '75ch', ...descriptionSx }}>
                        {step.body}
                      </Typography>
                    </Box>
                  ))}
                  <Box>
                    <Button component={RouterLink} to={path} variant="outlined" size="small">
                      ไปที่หน้า{guide.title}
                    </Button>
                  </Box>
                </Stack>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </Box>
    </Box>
  );
}
