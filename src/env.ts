function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} — ดู .env.example`);
  return v;
}

// getter ทั้งหมดเพื่อให้ `npm run migrate` ไม่ต้องมี env ของ OAuth ครบก่อน
export const env = {
  get databaseUrl() { return required('DATABASE_URL'); },
  get encryptionKey() { return required('ENCRYPTION_KEY'); },
  get sessionSecret() { return required('SESSION_SECRET'); },
  get googleClientId() { return required('GOOGLE_CLIENT_ID'); },
  get googleClientSecret() { return required('GOOGLE_CLIENT_SECRET'); },
  get baseUrl() { return required('BASE_URL').replace(/\/$/, ''); },
  get inviteCode() { return required('SIGNUP_INVITE_CODE'); },
  get adminEmail() { return required('ADMIN_EMAIL').toLowerCase(); },
  get pdfStorageDir() { return process.env.PDF_STORAGE_DIR ?? './data/pdf'; },
  get taxDocStorageDir() { return process.env.TAX_DOC_STORAGE_DIR ?? './data/tax-docs'; },
  get port() { return Number(process.env.PORT ?? 3000); },
  get isProd() { return process.env.NODE_ENV === 'production'; },
};
