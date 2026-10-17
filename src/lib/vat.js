// EU VAT number (VIES formats) offline format + checksum check. Never calls VIES.
// Algorithms: the national check-digit rules as published by the member states' tax administrations and as
// implemented in the open-source python-stdnum reference (used as the test oracle, see test/vat.test.js).
// check functions return null when the checksum passes, or { expected } / { reason } when it fails.
import { luhnValid, luhnCheckDigit, mod11_10, mod97, result } from './util.js';

const d = (s, i) => s.charCodeAt(i) - 48;
const wsum = (s, weights) => weights.reduce((a, w, i) => a + w * d(s, i), 0);
const exp = (actual, expected) => (String(actual) === String(expected) ? null : { expected: String(expected) });
const sumOk = (ok) => (ok ? null : {});

function validDate(y, m, day) {
  if (m < 1 || m > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// --- per-country checks -------------------------------------------------------------------------------------
function at(n) { // U + 8 digits
  const digits = n.slice(1);
  let s = 0;
  for (let i = 0; i < 7; i++) {
    let x = d(digits, i);
    if (i % 2 === 1) { x *= 2; if (x > 9) x -= 9; }
    s += x;
  }
  return exp(n[8], (10 - ((s + 4) % 10)) % 10);
}
const be = (n) => exp(n.slice(8), String(97 - (Number(n.slice(0, 8)) % 97)).padStart(2, '0'));
function bgLegal(n) {
  let c = n.slice(0, 8).split('').reduce((a, x, i) => a + (i + 1) * Number(x), 0) % 11;
  if (c === 10) c = n.slice(0, 8).split('').reduce((a, x, i) => a + (i + 3) * Number(x), 0) % 11;
  return exp(n[8], c % 10);
}
function bgEgn(n) {
  let y = Number(n.slice(0, 2)) + 1900, m = Number(n.slice(2, 4));
  const day = Number(n.slice(4, 6));
  if (m > 40) { y += 100; m -= 40; } else if (m > 20) { y -= 100; m -= 20; }
  if (!validDate(y, m, day)) return false;
  return String(wsum(n, [2, 4, 8, 5, 10, 9, 7, 3, 6]) % 11 % 10) === n[9];
}
const bgPnf = (n) => String(wsum(n, [21, 19, 17, 13, 11, 9, 7, 3, 1]) % 10) === n[9];
const bgOther = (n) => String((11 - (wsum(n, [4, 3, 2, 7, 6, 5, 4, 3, 2]) % 11)) % 11) === n[9];
function bg(n) {
  if (n.length === 9) return bgLegal(n);
  return sumOk(bgEgn(n) || bgPnf(n) || bgOther(n));
}
function cy(n) {
  const t = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21];
  let s = 0;
  for (let i = 0; i < 8; i++) s += i % 2 === 0 ? t[d(n, i)] : d(n, i);
  if (n.startsWith('12')) return { reason: 'Cypriot VAT numbers cannot start with 12' };
  return exp(n[8], String.fromCharCode(65 + (s % 26)));
}
function czBirth(n) { // rodne cislo (also used by SK)
  let y = 1900 + Number(n.slice(0, 2));
  const m = Number(n.slice(2, 4)) % 50 % 20, day = Number(n.slice(4, 6));
  if (n.length === 9) { if (y >= 1980) y -= 100; if (y > 1953) return false; } else if (y < 1954) y += 100;
  if (!validDate(y, m, day)) return false;
  if (n.length === 10) return String(Number(n.slice(0, 9)) % 11 % 10) === n[9];
  return true;
}
function cz(n) {
  if (n.length === 8) {
    if (n[0] === '9') return { reason: 'Czech 8-digit VAT numbers cannot start with 9' };
    const c = (11 - (wsum(n, [8, 7, 6, 5, 4, 3, 2]) % 11)) % 11;
    return exp(n[7], (c || 1) % 10);
  }
  if (n.length === 9 && n[0] === '6') {
    const c = wsum(n.slice(1), [8, 7, 6, 5, 4, 3, 2]) % 11;
    // JS % keeps the sign of the dividend, so (8 - ...) can be negative: normalise to 0-9.
    return exp(n[8], (((8 - ((10 - c) % 11)) % 10) + 10) % 10);
  }
  return czBirth(n) ? null : { reason: 'not a valid Czech individual (birth number) VAT format or checksum' };
}
const de = (n) => (n[0] === '0' ? { reason: 'German VAT numbers cannot start with 0' } : exp(n[8], mod11_10(n.slice(0, 8))));
const dk = (n) => (n[0] === '0' ? { reason: 'Danish VAT numbers cannot start with 0' } : sumOk(wsum(n, [2, 7, 6, 5, 4, 3, 2, 1]) % 11 === 0));
const ee = (n) => exp(n[8], (10 - (wsum(n, [3, 7, 1, 3, 7, 1, 3, 7]) % 10)) % 10);
function el(n) {
  let c = 0;
  for (let i = 0; i < 8; i++) c = c * 2 + d(n, i);
  return exp(n[8], (c * 2) % 11 % 10);
}
const DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';
function es(n) {
  const f = n[0];
  if (/\d/.test(f)) return exp(n[8], DNI[Number(n.slice(0, 8)) % 23]);
  if ('KLM'.includes(f)) return exp(n[8], DNI[Number(n.slice(1, 8)) % 23]);
  if ('XYZ'.includes(f)) return exp(n[8], DNI[Number('XYZ'.indexOf(f) + n.slice(1, 8)) % 23]);
  if ('ABCDEFGHJNPQRSUVW'.includes(f)) {
    const c = luhnCheckDigit(n.slice(1, 8));
    const letter = 'JABCDEFGHI'[c];
    return n[8] === String(c) || n[8] === letter ? null : { expected: `${c} or ${letter}` };
  }
  return { reason: `Spanish VAT numbers cannot start with ${f}` };
}
const fi = (n) => sumOk(wsum(n, [7, 9, 10, 5, 8, 4, 2, 1]) % 11 === 0);
const FR_ALPHA = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function fr(n) {
  const siren = n.slice(2);
  if (siren.slice(0, 3) !== '000' && !luhnValid(siren)) return { reason: 'SIREN part fails its Luhn checksum' };
  if (/^\d\d$/.test(n.slice(0, 2))) {
    return exp(n.slice(0, 2), String((Number(siren + '12') % 97)).padStart(2, '0'));
  }
  const a = FR_ALPHA.indexOf(n[0]), b = FR_ALPHA.indexOf(n[1]);
  if (a < 0 || b < 0) return { reason: 'French VAT key characters cannot be I or O' };
  const check = /\d/.test(n[0]) ? a * 24 + b - 10 : a * 34 + b - 100;
  return sumOk((Number(siren) + 1 + Math.floor(check / 11)) % 11 === check % 11);
}
const hr = (n) => exp(n[10], mod11_10(n.slice(0, 10)));
const hu = (n) => sumOk(wsum(n, [9, 7, 3, 1, 9, 7, 3, 1]) % 10 === 0);
const IE_ALPHA = 'WABCDEFGHIJKLMNOPQRSTUV';
function ieCheck(seven, extra) {
  const s = wsum(seven.padStart(7, '0'), [8, 7, 6, 5, 4, 3, 2]) + 9 * (extra ? IE_ALPHA.indexOf(extra) : 0);
  return IE_ALPHA[s % 23];
}
function ie(n) {
  if (/^\d{7}/.test(n)) return exp(n[7], ieCheck(n.slice(0, 7), n[8]));
  return exp(n[7], ieCheck(n.slice(2, 7) + n[0], undefined)); // old format: digit, letter/+/*, 5 digits, check
}
function it(n) {
  if (/^0{7}/.test(n)) return { reason: 'Italian VAT number (partita IVA) cannot start with 7 zeros' };
  const office = n.slice(7, 10);
  if (!((office >= '001' && office <= '100') || ['120', '121', '888', '999'].includes(office))) {
    return { reason: `province/office code ${office} is not in use` };
  }
  return exp(n[10], luhnCheckDigit(n.slice(0, 10)));
}
function lt(n) {
  if (n.length === 9 && n[7] !== '1') return { reason: '8th digit of a 9-digit Lithuanian VAT number must be 1' };
  if (n.length === 12 && n[10] !== '1') return { reason: '11th digit of a 12-digit Lithuanian VAT number must be 1' };
  const p = n.slice(0, -1);
  let c = 0;
  for (let i = 0; i < p.length; i++) c += (1 + (i % 9)) * d(p, i);
  c %= 11;
  if (c === 10) { c = 0; for (let i = 0; i < p.length; i++) c += (1 + ((i + 2) % 9)) * d(p, i); }
  return exp(n.slice(-1), c % 11 % 10);
}
const lu = (n) => exp(n.slice(6), String(Number(n.slice(0, 6)) % 89).padStart(2, '0'));
function lv(n) {
  if (n[0] > '3') return sumOk(wsum(n, [9, 1, 4, 8, 3, 10, 2, 5, 7, 6, 1]) % 11 === 3);
  const pers = (1 + wsum(n, [10, 5, 8, 4, 2, 1, 6, 3, 7, 9])) % 11 % 10;
  if (!n.startsWith('32')) {
    const y = Number(n.slice(4, 6)) + 1800 + Number(n[6]) * 100;
    if (!validDate(y, Number(n.slice(2, 4)), Number(n.slice(0, 2)))) return { reason: 'personal code does not contain a valid birth date' };
  }
  return exp(n[10], pers);
}
const mt = (n) => (n[0] === '0' ? { reason: 'Maltese VAT numbers cannot start with 0' } : sumOk(wsum(n, [3, 4, 6, 7, 8, 9, 10, 1]) % 37 === 0));
function nl(n) {
  if (Number(n.slice(0, 9)) === 0 || Number(n.slice(10)) === 0) return { reason: 'number and suffix cannot be zero' };
  const bsn = (wsum(n, [9, 8, 7, 6, 5, 4, 3, 2]) - d(n, 8)) % 11 === 0;
  return sumOk(bsn || mod97('NL' + n) === 1); // elfproef, or the mod-97 scheme for post-2020 sole-proprietor numbers
}
function pl(n) {
  const c = wsum(n, [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
  return c === 10 ? { reason: 'checksum fails (no valid check digit exists for this number)' } : exp(n[9], c);
}
const pt = (n) => (n[0] === '0' ? { reason: 'Portuguese VAT numbers cannot start with 0' } : exp(n[8], (11 - (wsum(n, [9, 8, 7, 6, 5, 4, 3, 2]) % 11)) % 11 % 10));
function ro(n) {
  if (n[0] === '0') return { reason: 'Romanian VAT numbers (CUI) cannot start with 0' };
  const p = n.slice(0, -1).padStart(9, '0');
  return exp(n.slice(-1), (10 * wsum(p, [7, 5, 3, 2, 1, 7, 5, 3, 2])) % 11 % 10);
}
function se(n) {
  if (!n.endsWith('01')) return { reason: 'Swedish VAT numbers end in 01' };
  return exp(n[9], luhnCheckDigit(n.slice(0, 9)));
}
function si(n) {
  if (n[0] === '0') return { reason: 'Slovenian VAT numbers cannot start with 0' };
  const c = 11 - (wsum(n, [8, 7, 6, 5, 4, 3, 2]) % 11);
  if (c === 11) return { reason: 'checksum fails (no valid check digit exists for this number)' };
  return exp(n[7], c === 10 ? 0 : c);
}
function sk(n) {
  if (czBirth(n)) return null;
  if (n[0] === '0' || !'234789'.includes(n[2])) return { reason: 'not a valid Slovak VAT format (3rd digit must be 2, 3, 4, 7, 8 or 9)' };
  return sumOk(Number(n) % 11 === 0);
}
function xi(n) { // UK VAT format, Northern Ireland prefix
  if (n.length === 5) {
    const k = Number(n.slice(2));
    if ((n.startsWith('GD') && k < 500) || (n.startsWith('HA') && k >= 500)) return null;
    return { reason: 'GD numbers must be below 500 and HA numbers 500 or above' };
  }
  const s = wsum(n, [8, 7, 6, 5, 4, 3, 2, 10, 1]) % 97;
  if (Number(n.slice(0, 3)) >= 100) return sumOk([0, 42, 55].includes(s));
  return sumOk(s === 0);
}

// prefix -> [name, format regex (after prefix), human format, check]
const VAT = {
  AT: ['Austria', /^U\d{8}$/, 'U + 8 digits', at],
  BE: ['Belgium', /^[01]\d{9}$/, '10 digits starting with 0 or 1', be],
  BG: ['Bulgaria', /^\d{9,10}$/, '9 or 10 digits', bg],
  CY: ['Cyprus', /^\d{8}[A-Z]$/, '8 digits + 1 letter', cy],
  CZ: ['Czechia', /^\d{8,10}$/, '8, 9 or 10 digits', cz],
  DE: ['Germany', /^\d{9}$/, '9 digits', de],
  DK: ['Denmark', /^\d{8}$/, '8 digits', dk],
  EE: ['Estonia', /^\d{9}$/, '9 digits', ee],
  EL: ['Greece', /^\d{9}$/, '9 digits', el],
  ES: ['Spain', /^[A-Z0-9]\d{7}[A-Z0-9]$/, '9 characters (letter/digit + 7 digits + letter/digit)', es],
  FI: ['Finland', /^\d{8}$/, '8 digits', fi],
  FR: ['France', /^[A-HJ-NP-Z0-9]{2}\d{9}$/, '2 key characters + 9-digit SIREN', fr],
  HR: ['Croatia', /^\d{11}$/, '11 digits', hr],
  HU: ['Hungary', /^\d{8}$/, '8 digits', hu],
  IE: ['Ireland', /^(\d{7}[A-W][A-W]?|\d[A-Z+*]\d{5}[A-W])$/, '7 digits + 1-2 letters (or old format digit, letter, 5 digits, letter)', ie],
  IT: ['Italy', /^\d{11}$/, '11 digits', it],
  LT: ['Lithuania', /^(\d{9}|\d{12})$/, '9 or 12 digits', lt],
  LU: ['Luxembourg', /^\d{8}$/, '8 digits', lu],
  LV: ['Latvia', /^\d{11}$/, '11 digits', lv],
  MT: ['Malta', /^\d{8}$/, '8 digits', mt],
  NL: ['Netherlands', /^\d{9}B\d{2}$/, '9 digits + B + 2 digits', nl],
  PL: ['Poland', /^\d{10}$/, '10 digits', pl],
  PT: ['Portugal', /^\d{9}$/, '9 digits', pt],
  RO: ['Romania', /^\d{2,10}$/, '2 to 10 digits', ro],
  SE: ['Sweden', /^\d{12}$/, '12 digits ending in 01', se],
  SI: ['Slovenia', /^\d{8}$/, '8 digits', si],
  SK: ['Slovakia', /^\d{10}$/, '10 digits', sk],
  XI: ['Northern Ireland (UK VAT, EU goods rules)', /^(\d{9}|\d{12}|GD\d{3}|HA\d{3})$/, '9 or 12 digits, or GD/HA + 3 digits', xi],
};
export const VAT_COUNTRIES = Object.fromEntries(Object.entries(VAT).map(([k, v]) => [k, { name: v[0], format: v[2] }]));

export function normalizeVat(input) {
  // Spaces, hyphens, dots, commas, slashes, colons and underscores are ignored; an optional "VAT" label is removed
  // (no EU VAT prefix starts with VA, so this can't eat a real prefix).
  return String(input ?? '').replace(/[\s\-.,/:_\u00a0]/g, '').toUpperCase().replace(/^VAT(?=[A-Z]{2})/, '');
}

export function validateVat(input) {
  let s = normalizeVat(input);
  const fail = (reason, extra) => result('vat', input, s, false, reason, extra);
  if (!s) return fail('empty input');
  if (!/^[A-Z]{2}/.test(s)) return fail('must start with the 2-letter EU VAT country prefix (e.g. DE, FR, EL for Greece)');
  let prefix = s.slice(0, 2);
  const notes = [];
  if (prefix === 'GR') { prefix = 'EL'; s = 'EL' + s.slice(2); notes.push('Greece uses the VAT prefix EL, not GR'); }
  const spec = VAT[prefix];
  if (!spec) {
    const why = prefix === 'GB' ? 'GB VAT numbers are not EU VAT numbers since 2021 (use XI for Northern Ireland goods trade)' : `${prefix} is not an EU VAT prefix`;
    return fail(why, { country: prefix });
  }
  let n = s.slice(2);
  if (prefix === 'BE' && /^\d{9}$/.test(n)) { n = '0' + n; s = 'BE' + n; notes.push('old 9-digit Belgian number, padded with a leading 0'); }
  if (prefix === 'EL' && /^\d{8}$/.test(n)) { n = '0' + n; s = 'EL' + n; notes.push('8-digit Greek number, padded with a leading 0'); }
  const base = { country: prefix, country_name: spec[0], number: n };
  if (notes.length) base.notes = notes;
  if (!spec[1].test(n)) return fail(`format does not match ${prefix}: expected ${spec[2]}`, { ...base, expected_format: spec[2] });
  const r = spec[3](n);
  if (r === null || r === undefined) return result('vat', input, s, true, null, { ...base, checksum: 'passed', vies_checked: false });
  if (r === false) return fail('checksum fails', base);
  if (r.reason) return fail(r.reason, base);
  if (r.expected !== undefined) return fail(`checksum fails, expected ${r.expected}`, { ...base, expected_check: r.expected });
  return fail('checksum fails', base);
}
