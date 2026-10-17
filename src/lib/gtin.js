// GTIN family (GS1 General Specifications, mod-10 with weights 3/1 from the right) and ISBN-10 (mod 11).
import { result } from './util.js';

const TYPES = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' };

export function normalizeCode(input) {
  // Spaces, hyphens and dots are ignored; an optional "ISBN" / "ISBN-13:" label is removed. "ISBN 108456789X" must
  // keep its leading 10. The 10/13 qualifier is only a label when a colon follows it, or when exactly 10 or 13
  // characters remain after it.
  const c = String(input ?? '').replace(/[\s\-.\u00a0]/g, '').toUpperCase();
  const q = /^ISBN(1[03]):?(.*)$/.exec(c);
  if (q && (c[6] === ':' || q[2].length === 10 || q[2].length === 13)) return q[2];
  return c.replace(/^ISBN:?/, '');
}

/** GS1 check digit for a payload of digits (everything except the check digit). */
export function gs1CheckDigit(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    const d = payload.charCodeAt(payload.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** ISBN-10 check character ("0"-"9" or "X") for 9 payload digits. */
export function isbn10CheckChar(payload9) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * (payload9.charCodeAt(i) - 48);
  const c = (11 - (sum % 11)) % 11;
  return c === 10 ? 'X' : String(c);
}

export function isbn10to13(isbn10) {
  const p = '978' + isbn10.slice(0, 9);
  return p + gs1CheckDigit(p);
}
export function isbn13to10(isbn13) {
  if (!isbn13.startsWith('978')) return null; // 979 ISBNs have no ISBN-10 form
  const p = isbn13.slice(3, 12);
  return p + isbn10CheckChar(p);
}

/** GS1 prefix notes (first 3 digits of the GTIN-13 form). Informational only. */
function gs1PrefixInfo(gtin13) {
  const p = Number(gtin13.slice(0, 3));
  if (gtin13.startsWith('978') || gtin13.startsWith('979')) {
    return gtin13.startsWith('9790') ? 'ISMN (sheet music, prefix 979-0)' : 'Bookland: ISBN (prefix 978/979)';
  }
  if (p === 977) return 'ISSN (serial publications, prefix 977)';
  if ((p >= 20 && p <= 29) || (p >= 40 && p <= 49) || (p >= 200 && p <= 299)) return 'restricted circulation number (internal use within a company or region, not globally unique)';
  if (p >= 981 && p <= 984) return 'GS1 coupon identification (prefix 981-984)';
  if (p >= 990 && p <= 999) return 'coupon identification (prefix 99)';
  if (p >= 1 && p <= 19) return 'GS1 US (UPC-compatible, prefix 001-019)';
  if (p >= 30 && p <= 39) return 'GS1 US (UPC-compatible, prefix 030-039)';
  if (p >= 60 && p <= 139) return 'GS1 US (UPC-compatible, prefix 060-139)';
  if (p === 0) return 'GTIN-8 or UPC-E derived (prefix 000)';
  return null;
}

function checkFail(type, input, code, expected, extra) {
  return result(type, input, code, false, `checksum fails, expected ${expected}`, { ...extra, check_digit: code.slice(-1), expected_check_digit: String(expected) });
}

/** ISBN-10 or ISBN-13 (978/979). */
export function validateIsbn(input) {
  const code = normalizeCode(input);
  const fail = (reason, extra) => result('isbn', input, code, false, reason, extra);
  if (!code) return fail('empty input');
  if (code.length === 10) {
    if (!/^\d{9}[\dX]$/.test(code)) return fail('ISBN-10 must be 9 digits followed by a digit or X');
    const expected = isbn10CheckChar(code.slice(0, 9));
    const extra = { format: 'ISBN-10' };
    if (code[9] !== expected) return checkFail('isbn', input, code, expected, extra);
    return result('isbn', input, code, true, null, { ...extra, check_digit: code[9], isbn10: code, isbn13: isbn10to13(code), gtin14: '0' + isbn10to13(code) });
  }
  if (code.length === 13) {
    if (!/^\d{13}$/.test(code)) return fail('ISBN-13 must be 13 digits');
    if (!/^97[89]/.test(code)) return fail('ISBN-13 must start with 978 or 979 (Bookland prefix)', { format: 'ISBN-13' });
    if (code.startsWith('9790')) return fail('979-0 is the ISMN range (sheet music), not an ISBN; check it with /v1/gtin', { format: 'ISBN-13' });
    const expected = gs1CheckDigit(code.slice(0, 12));
    const extra = { format: 'ISBN-13' };
    if (Number(code[12]) !== expected) return checkFail('isbn', input, code, expected, extra);
    const isbn10 = isbn13to10(code);
    const out = { ...extra, check_digit: code[12], isbn13: code, isbn10, gtin14: '0' + code };
    if (!isbn10) out.note = '979-prefixed ISBNs have no ISBN-10 equivalent';
    return result('isbn', input, code, true, null, out);
  }
  return fail(`length is ${code.length}, an ISBN has 10 or 13 characters`);
}

/** GTIN-8/12/13/14 (EAN-8, UPC-A, EAN-13, GTIN-14) plus ISBN-10. */
export function validateGtin(input) {
  const code = normalizeCode(input);
  const fail = (reason, extra) => result('gtin', input, code, false, reason, extra);
  if (!code) return fail('empty input');
  if (code.length === 10 && /^\d{9}[\dX]$/.test(code)) {
    const r = validateIsbn(code);
    return { ...r, type: 'gtin', input, format: 'ISBN-10' };
  }
  if (!/^\d+$/.test(code)) return fail('must contain digits only');
  const format = TYPES[code.length];
  if (!format) return fail(`length is ${code.length}, expected 8, 12, 13 or 14 digits (or a 10-character ISBN-10)`);
  const expected = gs1CheckDigit(code.slice(0, -1));
  const extra = { format };
  if (Number(code.slice(-1)) !== expected) return checkFail('gtin', input, code, expected, extra);
  const gtin14 = code.padStart(14, '0');
  const out = { ...extra, check_digit: code.slice(-1), gtin14 };
  const gtin13 = gtin14.startsWith('0') ? gtin14.slice(1) : null;
  if (code.length === 12) out.ean13 = '0' + code; // UPC-A -> EAN-13
  if (code.length === 13 && code.startsWith('0')) out.upc_a = code.slice(1); // EAN-13 with leading 0 -> UPC-A
  if (code.length === 14) {
    out.indicator_digit = code[0];
    if (code[0] === '0') out.ean13 = code.slice(1);
  }
  if (gtin13 && /^97[89]/.test(gtin13) && !gtin13.startsWith('9790') && code.length !== 8) {
    out.isbn13 = gtin13;
    const i10 = isbn13to10(gtin13);
    if (i10) out.isbn10 = i10;
  }
  const info = gtin13 && code.length !== 8 ? gs1PrefixInfo(gtin13) : null;
  if (info) out.prefix_note = info;
  return result('gtin', input, code, true, null, out);
}
