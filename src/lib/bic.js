// BIC (ISO 9362) format check: 4 party prefix + 2 country + 2 location [+ 3 branch]. No bank directory lookup.
import { COUNTRIES } from './countries.js';
import { result } from './util.js';

export function normalizeBic(input) {
  // Spaces, hyphens and dots are ignored; a "BIC:" / "SWIFT:" label is removed (colon required, since a real BIC
  // can start with the letters BIC).
  return String(input ?? '').replace(/[\s\-.\u00a0]/g, '').toUpperCase().replace(/^(BIC|SWIFT(CODE)?):/, '');
}

export function validateBic(input) {
  const bic = normalizeBic(input);
  const fail = (reason, extra) => result('bic', input, bic, false, reason, extra);
  if (!bic) return fail('empty input');
  if (!/^[A-Z0-9]+$/.test(bic)) return fail('contains characters other than letters and digits');
  if (bic.length !== 8 && bic.length !== 11) return fail(`length is ${bic.length}, a BIC has 8 or 11 characters`);
  const party = bic.slice(0, 4), country = bic.slice(4, 6), location = bic.slice(6, 8), branch = bic.slice(8) || null;
  // ISO 9362:2014+ allows alphanumeric party prefixes; in practice almost all are 4 letters.
  if (!/^[A-Z]{2}$/.test(country)) return fail('characters 5-6 must be a 2-letter country code');
  if (!COUNTRIES[country]) return fail(`${country} is not an ISO 3166 country code`, { country });
  if (!/^[A-Z0-9]{2}$/.test(location)) return fail('characters 7-8 (location code) must be letters or digits');
  const out = {
    bank_code: party,
    country,
    country_name: COUNTRIES[country],
    location_code: location,
    branch_code: branch,
    primary_office: !branch || branch === 'XXX',
    test_bic: location[1] === '0',
    bic8: bic.slice(0, 8),
    bic11: branch ? bic : bic + 'XXX',
  };
  const notes = [];
  if (!/^[A-Z]{4}$/.test(party)) notes.push('party prefix contains digits (allowed since ISO 9362:2014, but rare)');
  if (location[1] === '0') notes.push('location code ending in 0 marks a test/training BIC');
  if (location[1] === '1') notes.push('location code ending in 1 marks a passive participant (not connected to the SWIFT network)');
  if (branch && branch[0] === 'X' && branch !== 'XXX') notes.push('branch codes starting with X are normally only used for XXX (primary office)');
  if (notes.length) out.notes = notes;
  return result('bic', input, bic, true, null, out);
}
