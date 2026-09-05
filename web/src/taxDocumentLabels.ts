import type { TaxDocumentType, TaxEntityType } from './api.js';

export const DOCUMENT_TYPE_LABEL: Record<TaxDocumentType, string> = {
  tax_invoice: 'ใบกำกับภาษี',
  e_tax_invoice: 'e-Tax Invoice',
  receipt: 'ใบเสร็จรับเงิน',
  withholding_certificate: 'หนังสือรับรองหักภาษี ณ ที่จ่าย',
  insurance_certificate: 'หนังสือรับรองเบี้ยประกัน',
  donation_receipt: 'ใบอนุโมทนาบัตร/หลักฐานบริจาค',
  investment_certificate: 'หนังสือรับรองการลงทุน',
  other: 'อื่น ๆ',
};

export const TAX_ENTITY_TYPE_LABEL: Record<TaxEntityType, string> = {
  individual: 'บุคคลธรรมดา',
  sole_proprietor: 'ร้านค้า/กิจการเจ้าของคนเดียว',
  company: 'บริษัท',
};
