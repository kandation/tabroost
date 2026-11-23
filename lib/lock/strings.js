// The only user-facing strings that live in the pure core (the sentinels named in the spec).
// Everything else (lock screen, settings card, popup) is UI work for the integrator.
export const STR = {
  corrupt: { th: 'รายการเสียหาย', en: 'Damaged item' },
  preparing: { th: 'กำลังเตรียม…', en: 'Preparing…' },
  wrongPassword: { th: 'รหัสผ่านไม่ถูกต้อง', en: 'Wrong password' },
  badRecoveryKey: { th: 'รหัสกู้คืนไม่ถูกต้อง', en: 'Invalid recovery key' },
};
export const tr = (key, lang = 'th') => (STR[key] && (STR[key][lang] || STR[key].th)) || key;
export const CORRUPT_SENTINEL = STR.corrupt.th;
