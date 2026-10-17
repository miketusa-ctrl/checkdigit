// Shared helpers for validators. Pure functions, no I/O.
export const MAX_CODE_LENGTH = 64;

/** Strip whitespace, hyphens and dots, upper-case. */
export function compact(s) {
  return String(s ?? '').replace(/[\s\-.\u00a0]/g, '').toUpperCase();
}

/** ISO 7064 MOD 97-10 remainder of a string of digits/letters (letters A=10..Z=35), chunked (no BigInt). */
export function mod97(str) {
  let rem = 0;
  for (const ch of str) {
    const c = ch.charCodeAt(0);
    if (c >= 48 && c <= 57) rem = (rem * 10 + (c - 48)) % 97;
    else if (c >= 65 && c <= 90) rem = (rem * 100 + (c - 55)) % 97;
    else return NaN;
  }
  return rem;
}

/** Luhn: true when the full number (incl. check digit) is valid. */
export function luhnValid(digits) {
  return luhnSum(digits) % 10 === 0;
}
function luhnSum(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum;
}
/** Luhn check digit for a payload (without check digit). */
export function luhnCheckDigit(payload) {
  return (10 - (luhnSum(payload + '0') % 10)) % 10;
}

/** ISO 7064 MOD 11,10 check digit for a digit payload. */
export function mod11_10(payload) {
  let p = 10;
  for (const ch of payload) {
    let s = (Number(ch) + p) % 10;
    if (s === 0) s = 10;
    p = (2 * s) % 11;
  }
  return (11 - p) % 10;
}

export const isDigits = (s) => /^\d+$/.test(s);

export function result(type, input, normalized, valid, reason, extra = {}) {
  const out = { type, input, normalized, valid };
  if (!valid) out.reason = reason;
  return Object.assign(out, extra);
}
