// Auto-detect the identifier type by shape, run the matching validators, and pick the best answer.
import { IBAN_REGISTRY } from './iban-registry.js';
import { COUNTRIES } from './countries.js';
import { VAT_COUNTRIES, validateVat } from './vat.js';
import { validateIban } from './iban.js';
import { validateBic } from './bic.js';
import { validateGtin, validateIsbn } from './gtin.js';

export const VALIDATORS = { iban: validateIban, bic: validateBic, vat: validateVat, gtin: validateGtin, isbn: validateIsbn };

// Labels people paste along with the code ("IBAN: ...", "VAT: ...", "ISBN-13: ...", "BIC: ..."). They are removed
// before detection AND before the code is handed to the validators; `input` in the result stays the original.
const LABEL = /^\s*(?:ISBN(?:[\s-]*1[03])?\s*:?|IBAN\s*:?|VAT(?:\s*(?:NO|NUMBER|ID))?\s*:|VAT\s+|BIC\s*:|SWIFT(?:\s*CODE)?\s*:)\s*/i;
export function stripLabel(input) {
  const str = String(input ?? '');
  // "ISBN 108456789X" is an ISBN-10 starting with 10, not "ISBN-10: 8456789X". Strip the 10/13 qualifier only when
  // a colon follows it or exactly 10 or 13 code characters remain after it.
  const q = /^\s*ISBN([\s-]*)(1[03])(\s*:)?\s*(.*)$/i.exec(str);
  if (q && !q[3]) {
    const rest = q[4].replace(/[\s\-.\u00a0]/g, '');
    if (rest.length !== 10 && rest.length !== 13) return str.replace(/^\s*ISBN\s*:?\s*/i, '');
  }
  return str.replace(LABEL, '');
}
function shape(input) {
  return stripLabel(input).replace(/[\s\-.\u00a0]/g, '').toUpperCase();
}

/** Candidate types for an input, most specific first. */
export function candidates(input) {
  const s = shape(input);
  const out = [];
  const cc = s.slice(0, 2);
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s) && IBAN_REGISTRY[cc]) out.push('iban');
  if (/^[A-Z]{2}[A-Z0-9+*]{2,13}$/.test(s) && (VAT_COUNTRIES[cc] || cc === 'GR') && /\d/.test(s.slice(2))) out.push('vat');
  if (/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(s) && /^[A-Z]/.test(s) && COUNTRIES[s.slice(4, 6)]) out.push('bic');
  if (/^\d{9}[\dX]$/.test(s) || /^97[89]\d{10}$/.test(s)) out.push('isbn');
  if (/^(\d{8}|\d{12,14})$/.test(s)) out.push('gtin');
  return out;
}

// Ranking when several types fit the shape: a valid result wins; otherwise a failure where the code had the right
// shape for that type (a checksum or content rule failed) beats a structural failure (wrong length or format). Ties
// keep the candidate order (most specific first).
const STRUCTURAL = /^(empty input|contains characters|must |characters \d|character \d+ must|length is|format does not match|ISBN-1[03] must|BBAN does not match|country \S+ .*is not in|\S+ is not an? )/;
export const score = (r) => (r.valid ? 3 : STRUCTURAL.test(r.reason || '') ? 1 : 2);

export function detect(input) {
  const types = candidates(input);
  if (!types.length) {
    return {
      type: null, input, normalized: shape(input), valid: false,
      reason: 'not recognised as an IBAN, BIC, EU VAT number, GTIN/EAN/UPC or ISBN',
      candidates: [],
    };
  }
  const code = stripLabel(input);
  let best = null;
  for (const t of types) {
    const r = VALIDATORS[t](code);
    if (!best || score(r) > score(best)) best = r;
    if (r.valid) break;
  }
  return { ...best, input, detected_as: best.type, candidates: types };
}
