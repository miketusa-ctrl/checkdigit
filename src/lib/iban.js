// IBAN validation: ISO 13616 structure + MOD 97-10 (ISO 7064), per-country length/BBAN format from the SWIFT registry.
import { IBAN_REGISTRY } from './iban-registry.js';
import { COUNTRIES } from './countries.js';
import { mod97, result } from './util.js';

const CLASS = { n: '[0-9]', a: '[A-Z]', c: '[A-Z0-9]', e: ' ' };
const bbanRegexCache = new Map();

/** "4!a6!n8!n" -> /^[A-Z]{4}[0-9]{6}[0-9]{8}$/ (all registry entries use fixed-length "!" items). */
export function structureToRegex(structure) {
  let re = bbanRegexCache.get(structure);
  if (re) return re;
  let src = '^';
  for (const m of structure.matchAll(/(\d+)(!?)([nace])/g)) {
    src += `${CLASS[m[3]]}{${m[2] ? m[1] : `1,${m[1]}`}}`;
  }
  re = new RegExp(src + '$');
  bbanRegexCache.set(structure, re);
  return re;
}

/** Explain the first BBAN position that breaks the registry structure (1-based position within the IBAN). */
function bbanMismatch(bban, structure) {
  let pos = 0;
  for (const m of structure.matchAll(/(\d+)!?([nace])/g)) {
    const len = Number(m[1]);
    const cls = new RegExp(`^${CLASS[m[2]]}$`);
    for (let i = 0; i < len; i++, pos++) {
      const ch = bban[pos];
      if (ch === undefined || !cls.test(ch)) {
        const want = { n: 'a digit', a: 'a letter', c: 'a letter or digit', e: 'a space' }[m[2]];
        return `character ${pos + 5} must be ${want} (BBAN structure ${structure})`;
      }
    }
  }
  return `BBAN does not match structure ${structure}`;
}

export function formatIban(iban) {
  return iban.replace(/(.{4})/g, '$1 ').trim();
}

export function normalizeIban(input) {
  // Spaces, hyphens and dots are ignored; an optional "IBAN" / "IBAN:" label is removed.
  return String(input ?? '').replace(/[\s\-.\u00a0]/g, '').toUpperCase().replace(/^IBAN:?/, '');
}

export function expectedCheckDigits(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 2) + '00';
  return String(98 - mod97(rearranged)).padStart(2, '0');
}

export function validateIban(input) {
  const iban = normalizeIban(input);
  const fail = (reason, extra) => result('iban', input, iban, false, reason, extra);
  if (!iban) return fail('empty input');
  if (!/^[A-Z0-9]+$/.test(iban)) return fail('contains characters other than letters and digits');
  if (!/^[A-Z]{2}/.test(iban)) return fail('must start with a 2-letter country code');
  const country = iban.slice(0, 2);
  const spec = IBAN_REGISTRY[country];
  if (!spec) {
    return fail(COUNTRIES[country]
      ? `country ${country} (${COUNTRIES[country]}) is not in the SWIFT IBAN Registry`
      : `${country} is not an ISO 3166 country code`, { country });
  }
  const base = { country, country_name: COUNTRIES[country] || null, sepa: spec.sepa };
  if (!/^[A-Z]{2}\d{2}/.test(iban)) return fail('characters 3-4 (check digits) must be digits', base);
  if (iban.length !== spec.length) {
    return fail(`length is ${iban.length}, expected ${spec.length} for ${country}`, { ...base, expected_length: spec.length });
  }
  const bban = iban.slice(4);
  const checkDigits = iban.slice(2, 4);
  const details = { ...base, check_digits: checkDigits, bban, bank_code: bban.slice(spec.bank[0], spec.bank[1]) || null, formatted: formatIban(iban) };
  if (!structureToRegex(spec.bban).test(bban)) return fail(bbanMismatch(bban, spec.bban), details);
  const expected = expectedCheckDigits(iban);
  if (checkDigits === '00' || checkDigits === '01' || checkDigits === '99') {
    return fail(`check digits ${checkDigits} are never valid (allowed range 02-98), expected ${expected}`, { ...details, expected_check_digits: expected });
  }
  if (mod97(bban + iban.slice(0, 4)) !== 1) {
    return fail(`checksum fails, expected check digits ${expected} (mod 97)`, { ...details, expected_check_digits: expected });
  }
  return result('iban', input, iban, true, null, { ...details, electronic: iban });
}

export const IBAN_COUNTRIES = Object.keys(IBAN_REGISTRY);
