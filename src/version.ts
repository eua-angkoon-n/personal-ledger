// แหล่งเดียวของเลขเวอร์ชันแอป — ห้ามมีที่อื่น (package.json เป็น private ไม่มี field version
// และ runtime stage ของ Dockerfile ไม่การันตีว่าอ่านไฟล์นั้นได้ตอนบูต)
// กฎการอัปเดต: ดู AGENTS.md §Versioning และ docs/deploy.md §อัปเดต
// ทุกครั้งที่ deploy ขึ้น production ต้องขยับเลขนี้ + เพิ่มหัวข้อใน CHANGELOG.md ให้ตรงกัน
// minor = ฟีเจอร์ใหม่ · patch = แก้บั๊ก/ปรับเล็ก · major = เปลี่ยนโครงจนผู้ใช้ต้องเรียนรู้ใหม่
export const APP_VERSION = '1.2.1';
