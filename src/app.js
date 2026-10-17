// CheckDigit request router. Free of Worker-only imports so it can be unit-tested in Node.
// Privacy: identifiers are validated in memory and returned to the caller only. Nothing here logs (no console.*),
// and the only things stored are counters (per-key monthly usage, global daily totals).
import { VALIDATORS, detect } from './lib/detect.js';
import { IBAN_REGISTRY, IBAN_REGISTRY_SOURCE } from './lib/iban-registry.js';
import { VAT_COUNTRIES } from './lib/vat.js';
import { MAX_CODE_LENGTH } from './lib/util.js';
import { extractApiKey, lookupKey, peekKey, StorageError } from './lib/keys.js';
import { consumeMonthlyQuota, QuotaUnavailable, secondsToNextUtcMonth } from './lib/quota.js';
import { budgetAllows, budgetRecord, secondsToUtcMidnight } from './lib/budget.js';
import { readBodyCapped, declaredTooLarge, tooLarge, BodyError, MAX_BODY_BYTES } from './lib/body.js';
import { VERSION } from './lib/version.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard, glamaJson } from './lib/agentdocs.js';
import { countVisitor } from './lib/visitors.js';

export { VERSION };
export const BATCH_MAX = 500;
export const DISCLAIMER = 'This is a format check, not a compliance check. A valid format or checksum does not prove that a bank account, VAT registration, bank (BIC) or product exists, is active, or belongs to anyone in particular.';

// Defaults mirror wrangler.toml [vars]. The per-minute values must match the ratelimit bindings' simple.limit
// (the binding enforces; these drive messages and the in-isolate fallback when a binding is missing).
export const DEFAULT_LIMITS = {
  anonPerMin: 20, // VALIDATE_LIMIT_PER_MIN / VALIDATE_LIMITER (per IP)
  keyPerMin: 300, // KEY_LIMIT_PER_MIN / KEY_LIMITER (per API key)
  freePerMonth: 1000, // FREE_MONTHLY_QUOTA (KeyQuota DO, exact)
  proPerMonth: 50000, // PRO_MONTHLY_QUOTA (KeyQuota DO, exact)
  callsPerDay: 15000, // DAILY_CALL_POOL: global daily soft cap, all requests (approximate)
  anonPerDay: 10000, // DAILY_ANON_POOL: anonymous share of the pool
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
export function limitsFor(env = {}) {
  const L = DEFAULT_LIMITS;
  return {
    anonPerMin: num(env.VALIDATE_LIMIT_PER_MIN, L.anonPerMin),
    keyPerMin: num(env.KEY_LIMIT_PER_MIN, L.keyPerMin),
    freePerMonth: num(env.FREE_MONTHLY_QUOTA, L.freePerMonth),
    proPerMonth: num(env.PRO_MONTHLY_QUOTA, L.proPerMonth),
    callsPerDay: num(env.DAILY_CALL_POOL, L.callsPerDay),
    anonPerDay: num(env.DAILY_ANON_POOL, L.anonPerDay),
  };
}
const fmt = (n) => n.toLocaleString('en-US');

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key',
  'access-control-expose-headers': 'retry-after, x-checkdigit-plan, x-quota-limit, x-quota-remaining, x-ratelimit-limit',
  'access-control-max-age': '86400',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const staging = (env) => String(env.PUBLIC_LAUNCH || 'false') !== 'true';

function withHygiene(headers, env) {
  if (staging(env)) headers['x-robots-tag'] = 'noindex, nofollow';
  return headers;
}
function json(env, body, status = 200, extra = {}, pretty = true) {
  return new Response(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body), {
    status,
    headers: withHygiene({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...SECURITY, ...extra }, env),
  });
}
const apiError = (env, status, code, message, extra) => json(env, { error: { code, message } }, status, extra);

function page(env, body, type, status = 200, cache = 'public, max-age=300') {
  return new Response(body, {
    status,
    headers: withHygiene({ 'content-type': type, 'cache-control': cache, 'content-security-policy': CSP, ...SECURITY }, env),
  });
}

// Per-isolate fallback limiter (best effort; the Workers Rate Limiting binding is authoritative when bound).
const memLimits = new Map();
export function clearMemLimits() { memLimits.clear(); }
function memLimit(key, limit, periodMs) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) {
    if (memLimits.size > 5000) memLimits.clear();
    memLimits.set(key, { start: now, n: 1 });
    return true;
  }
  e.n++;
  return e.n <= limit;
}
// Buckets: 'key' -> KEY_LIMITER (per API key); 'ip' (anonymous calls) and 'auth' (API-key lookups that need KV, and
// failed auth) -> VALIDATE_LIMITER, per IP. 'auth' is a separate counter so a key holder behind a busy shared IP
// isn't blocked by other people's anonymous traffic, while a bad-key flood from one IP still gets 429.
async function isRateLimited(env, bucket, id, limit) {
  const binding = bucket === 'key' ? env.KEY_LIMITER : env.VALIDATE_LIMITER;
  const key = `${bucket}:${id}`;
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return !success; } catch { /* fall back */ }
  }
  return !memLimit(key, limit, 60_000);
}

// Limiter key for an IP: IPv4 as is, IPv6 -> its /64 (v0.2.0, recipe r2 §1; same output as burnercheck/workdayapi).
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped ::ffff:a.b.c.d
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}
const clientIp = (request) => ipBucket(request.headers.get('cf-connecting-ip') || 'unknown-client');

/**
 * Key gate shared by /v1/* and /mcp (recipe r2 §1). -> { ok:true, rec } (rec null = anonymous) |
 * { ok:false, status, code, message, headers }. Never echoes the key.
 */
export async function authenticate(request, env, L = limitsFor(env)) {
  const raw = extractApiKey(request);
  if (raw === null) return { ok: true, rec: null };
  // Failed auth must not be free. Any key that needs a KV read (isolate cache miss), and any key that turns out to
  // be unknown, is charged to the per-IP 'auth' bucket first, so a flood of random keys gets 429, not unlimited
  // 401s and KV reads. A valid key that's already cached (the normal hot path) skips this.
  const authLimited = () => isRateLimited(env, 'auth', clientIp(request), L.anonPerMin);
  const authTooMany = { ok: false, status: 429, code: 'rate_limited', message: `Too many API key checks from this IP address (limit ${L.anonPerMin} per minute for new or unrecognised keys). Retry in about a minute.`, headers: { 'retry-after': '60', 'x-ratelimit-limit': String(L.anonPerMin) } };
  const peek = await peekKey(env.KEYS, raw);
  if (!peek.hit && await authLimited()) return authTooMany;
  let rec;
  try { rec = peek.hit ? peek.rec : await lookupKey(env.KEYS, raw); } catch (e) {
    if (e instanceof StorageError) return { ok: false, status: 503, code: 'storage_unavailable', message: 'Key lookup is temporarily unavailable. Retry shortly, or call without a key (anonymous limits apply).', headers: { 'retry-after': '30' } };
    throw e;
  }
  if (!rec) {
    if (peek.hit && await authLimited()) return authTooMany; // a miss was already charged above
    return { ok: false, status: 401, code: 'invalid_api_key', message: 'API key not recognised. Send it as "Authorization: Bearer cd_live_..." or "X-Api-Key", or omit it to use the anonymous tier.', headers: {} };
  }
  return { ok: true, rec };
}

/**
 * Authenticate + rate-limit + global pool. Returns { ctxInfo } or { response }.
 * kind: 'validate' (counts toward pool + quota), 'meta' (rate limit only).
 */
async function gate(request, env, L, { needPaid = false } = {}) {
  const auth = await authenticate(request, env, L);
  if (!auth.ok) return { response: apiError(env, auth.status, auth.code, auth.message, auth.headers) };
  const rec = auth.rec;
  if (needPaid) {
    if (!rec) return { response: apiError(env, 401, 'api_key_required', 'POST /v1/batch requires a paid (Pro) API key.') };
    if (rec.plan !== 'pro') return { response: apiError(env, 403, 'paid_plan_required', 'POST /v1/batch is available on the Pro plan only. Free keys can use the single-code endpoints (GET, or POST with {"code": "..."}).', { 'x-checkdigit-plan': rec.plan }) };
  }
  const limited = rec
    ? await isRateLimited(env, 'key', rec.keyId, L.keyPerMin)
    : await isRateLimited(env, 'ip', clientIp(request), L.anonPerMin);
  if (limited) {
    const per = rec ? `${L.keyPerMin} requests per minute per API key` : `${L.anonPerMin} requests per minute per IP address without an API key`;
    return { response: apiError(env, 429, 'rate_limited', `Rate limit reached (${per}). Retry in about a minute.`, { 'retry-after': '60', 'x-ratelimit-limit': String(rec ? L.keyPerMin : L.anonPerMin) }) };
  }
  return { rec };
}

async function chargeQuotaAndPool(env, ctx, L, rec, units) {
  const kind = rec ? 'key' : 'anon';
  const pool = budgetAllows(kind, L);
  if (!pool.ok) {
    const msg = pool.pool === 'anon'
      ? 'The free anonymous capacity for today is used up. Use an API key, or try again after 00:00 UTC.'
      : 'CheckDigit has reached its daily capacity. Try again after 00:00 UTC.';
    return { response: apiError(env, 429, 'daily_capacity_reached', msg, { 'retry-after': String(secondsToUtcMidnight()) }) };
  }
  const headers = {};
  if (rec) {
    const limit = rec.plan === 'pro' ? L.proPerMonth : L.freePerMonth;
    headers['x-checkdigit-plan'] = rec.plan;
    headers['x-quota-limit'] = String(limit);
    try {
      const q = await consumeMonthlyQuota(env.QUOTA, `key:${rec.keyId}`, limit, units);
      if (!q.ok) {
        const left = Math.max(0, q.limit - q.used);
        const msg = units > 1 && left > 0
          ? `This batch needs ${fmt(units)} calls but only ${fmt(left)} remain in this month's quota of ${fmt(limit)}.`
          : `Monthly quota of ${fmt(limit)} calls used up for ${q.month} (UTC). It resets on the 1st of next month.`;
        return { response: apiError(env, 429, 'monthly_quota_exceeded', msg, { ...headers, 'x-quota-remaining': String(left), 'retry-after': String(secondsToNextUtcMonth()) }) };
      }
      headers['x-quota-remaining'] = String(Math.max(0, q.limit - q.used));
    } catch (e) {
      if (!(e instanceof QuotaUnavailable)) throw e;
      headers['x-quota-remaining'] = 'unavailable'; // fail open: rate limits + daily pool still apply
    }
  }
  budgetRecord(kind, env.QUOTA, ctx);
  return { headers };
}

function decodeCode(rest) {
  try { return decodeURIComponent(rest); } catch { return null; }
}

function meta(env, L) {
  return {
    service: 'CheckDigit',
    version: VERSION,
    build: env.BUILD_SHA || 'unknown', // git commit the deployed code was built from (set by scripts/deploy.sh)
    built_at: env.BUILD_TIME || null,
    staging: staging(env),
    disclaimer: DISCLAIMER,
    endpoints: [
      'GET /v1/iban/{iban}', 'GET /v1/bic/{bic}', 'GET /v1/vat/{number}', 'GET /v1/gtin/{code}',
      'GET /v1/isbn/{code}', 'GET /v1/detect/{code}',
      'POST /v1/iban', 'POST /v1/bic', 'POST /v1/vat', 'POST /v1/gtin', 'POST /v1/isbn', 'POST /v1/detect',
      'POST /v1/batch', 'GET /v1/meta',
    ],
    post_single: 'POST /v1/{type} with JSON {"code": "..."} keeps the code out of the URL. Same limits as GET; no key needed.',
    iban: { countries: Object.keys(IBAN_REGISTRY).length, country_codes: Object.keys(IBAN_REGISTRY), source: IBAN_REGISTRY_SOURCE },
    vat: { countries: Object.keys(VAT_COUNTRIES), vies: false, note: 'Offline format and checksum only. VIES (registration status) is not queried.' },
    gtin: { formats: ['EAN-8', 'UPC-A (GTIN-12)', 'EAN-13 (GTIN-13)', 'GTIN-14', 'ISBN-10', 'ISBN-13'], not_supported: ['UPC-E (8-digit zero-suppressed UPC)'], algorithm: 'GS1 mod 10; ISBN-10 mod 11' },
    bic: { note: 'Format and country only (ISO 9362). No bank directory lookup.' },
    limits: {
      max_code_length: MAX_CODE_LENGTH,
      post_body_max_bytes: MAX_BODY_BYTES,
      batch_max_codes: BATCH_MAX,
      anonymous_per_minute_per_ip: L.anonPerMin,
      api_key_per_minute: L.keyPerMin,
      free_key_calls_per_month: L.freePerMonth,
      pro_key_calls_per_month: L.proPerMonth,
      batch_plan: 'pro',
      daily_capacity_note: 'A global daily soft cap protects the service; if it is reached, requests get 429 daily_capacity_reached until 00:00 UTC.',
    },
    privacy: 'Identifiers are checked in memory and not stored or logged. Only request counts are kept, plus a salted, daily-rotating hash of the visitor IP (kept up to 9 days) to count unique visitors per day; no IP address is stored.',
  };
}

function robots(env) {
  return staging(env) ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\nDisallow: /v1/\n';
}

const AGENT_X = { batchMax: BATCH_MAX, restBodyBytes: MAX_BODY_BYTES, maxCode: MAX_CODE_LENGTH };
const AGENT_DOCS = ['/llms.txt', '/openapi.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-registry-auth', '/.well-known/glama.json'];
export const REGISTRY_AUTH_RE = /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/;
// Daily unique visitors are counted on human/API entry points only, never on internal MCP->API calls.
const COUNTED = (path, method) => (method === 'GET' && (path === '/' || path === '/index.html' || path === '/docs' || path === '/docs/'))
  || (path.startsWith('/v1/') && !path.startsWith('/v1/meta')) || (path === '/mcp' && method === 'POST');
const internal = new WeakSet();

export function createApp({ pages }) {
  const banner = '<div class="staging" role="note">Staging preview. Not public yet. Results and limits may change.</div>';
  const render = (env, html) => html.replace('<!--STAGING-->', staging(env) ? banner : '');

  // Internal call into the exact /v1/* route (same key gate, limiters, pool, quota) for MCP tools (recipe r2 §1).
  // Only the caller's key + client IP headers are forwarded; codes travel in a POST body, never a URL.
  function runApi(request, env, ctx, { method, path, body }) {
    const h = new Headers({ 'content-type': 'application/json' });
    for (const k of ['authorization', 'x-api-key', 'cf-connecting-ip']) { const v = request.headers.get(k); if (v !== null) h.set(k, v); }
    const req = new Request(new URL(path, request.url), { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) });
    internal.add(req);
    return handle(req, env, ctx);
  }

  async function handle(request, env = {}, ctx = undefined) {
    if (!internal.has(request) && COUNTED(new URL(request.url).pathname, request.method)) countVisitor(request, env, ctx, clientIp(request));
    return route(request, env, ctx);
  }

  async function route(request, env = {}, ctx = undefined) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const L = limitsFor(env);

    if (path === '/mcp') {
      return handleMcp(request, env, ctx, {
        authenticate: (r, e) => authenticate(r, e, L), runApi, ipBucket: clientIp(request), memLimit,
        origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits: L, security: withHygiene({ ...SECURITY }, env),
      });
    }

    // ---- machine-readable docs (v0.2.0, recipe r2 §3/§4/§10, Smithery server card §13.2) ----
    if (AGENT_DOCS.includes(path)) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: withHygiene({ ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS' }, env) });
      if (method !== 'GET' && method !== 'HEAD') return apiError(env, 405, 'method_not_allowed', 'Use GET.', { allow: 'GET, HEAD, OPTIONS' });
      const doc = (body, type, cache = 'public, max-age=3600', status = 200) => new Response(method === 'HEAD' ? null : body, {
        status, headers: withHygiene({ 'content-type': type, 'cache-control': cache, 'access-control-allow-origin': '*', ...SECURITY }, env),
      });
      if (path === '/llms.txt') return doc(llmsTxt(url.origin, L, AGENT_X), 'text/plain; charset=utf-8');
      if (path === '/openapi.json') return doc(JSON.stringify(openApiSpec(url.origin, L, AGENT_X), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/mcp/server-card.json') return doc(JSON.stringify(serverCard(url.origin), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/glama.json') return doc(glamaJson(), 'application/json; charset=utf-8');
      const v = String(env.MCP_REGISTRY_AUTH || '');
      if (REGISTRY_AUTH_RE.test(v)) return doc(v, 'text/plain; charset=utf-8', 'no-store');
      return doc('Not found\n', 'text/plain; charset=utf-8', 'no-store', 404);
    }

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: withHygiene({ ...CORS }, env) });

    if (!path.startsWith('/v1/')) {
      if (method !== 'GET' && method !== 'HEAD') return page(env, 'Method not allowed\n', 'text/plain; charset=utf-8', 405);
      if (path === '/' || path === '/index.html') return page(env, render(env, pages.index), 'text/html; charset=utf-8');
      if (path === '/docs' || path === '/docs/') return page(env, render(env, pages.docs), 'text/html; charset=utf-8');
      if (path === '/style.css') return page(env, pages.css, 'text/css; charset=utf-8');
      if (path === '/app.js') return page(env, pages.js, 'text/javascript; charset=utf-8');
      if (path === '/robots.txt') return page(env, robots(env), 'text/plain; charset=utf-8');
      if (path === '/favicon.ico') return new Response(null, { status: 204, headers: withHygiene({ 'cache-control': 'public, max-age=86400' }, env) });
      return page(env, 'Not found\n', 'text/plain; charset=utf-8', 404, 'no-store');
    }

    try {
      if (path === '/v1/batch') {
        if (method !== 'POST') return apiError(env, 405, 'method_not_allowed', 'Use POST for /v1/batch.', { allow: 'POST, OPTIONS' });
        if (declaredTooLarge(request)) throw tooLarge();
        const g = await gate(request, env, L, { needPaid: true });
        if (g.response) return g.response;
        const text = await readBodyCapped(request);
        let body;
        try { body = JSON.parse(text); } catch { return apiError(env, 400, 'invalid_json', 'Body must be JSON: {"codes": ["DE89370400440532013000", {"code": "9780306406157", "type": "isbn"}]}'); }
        const codes = body && Array.isArray(body.codes) ? body.codes : null;
        if (!codes) return apiError(env, 400, 'invalid_batch', 'Body must be a JSON object with a "codes" array.');
        if (codes.length === 0) return apiError(env, 400, 'empty_batch', 'The "codes" array is empty.');
        if (codes.length > BATCH_MAX) return apiError(env, 400, 'batch_too_large', `A batch can hold at most ${BATCH_MAX} codes (got ${fmt(codes.length)}). Split it into several requests.`);
        const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, codes.length);
        if (charged.response) return charged.response;
        const results = codes.map((item, index) => batchItem(item, index));
        const validCount = results.filter((r) => r.valid).length;
        return json(env, { count: results.length, valid_count: validCount, invalid_count: results.length - validCount, results }, 200, charged.headers, false); // compact: up to 500 results
      }

      const single = path.match(/^\/v1\/(iban|bic|vat|gtin|isbn|detect)(?:\/(.*))?$/);

      // POST /v1/{type} with {"code": "..."} keeps IBANs and VAT numbers out of URLs (edge logs, proxies,
      // history). Anonymous and free keys allowed; same per-IP/per-key limiter, 32 KB cap, pool and quota as GET.
      if (method === 'POST' && single) {
        const type = single[1];
        if (single[2]) return apiError(env, 400, 'code_in_url', `With POST, send the code in the JSON body and leave it out of the URL: POST /v1/${type} {"code": "..."}`);
        if (declaredTooLarge(request)) throw tooLarge();
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        const text = await readBodyCapped(request);
        let body;
        try { body = JSON.parse(text); } catch { return apiError(env, 400, 'invalid_json', `Body must be JSON: {"code": "${exampleFor(type)}"}`); }
        const code = body && typeof body === 'object' && !Array.isArray(body) ? body.code : undefined;
        if (typeof code !== 'string' || !code.trim()) return apiError(env, 400, 'missing_code', `Body must be a JSON object with a "code" string, e.g. {"code": "${exampleFor(type)}"}`);
        if (code.length > MAX_CODE_LENGTH) return apiError(env, 400, 'input_too_long', `Codes are at most ${MAX_CODE_LENGTH} characters.`);
        const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, 1);
        if (charged.response) return charged.response;
        const r = type === 'detect' ? detect(code) : VALIDATORS[type](code);
        return json(env, r, 200, charged.headers);
      }

      // Unknown /v1/ paths are 404 for every method, before the 405.
      if (!single && path !== '/v1/meta' && path !== '/v1/meta/') return apiError(env, 404, 'not_found', 'Unknown endpoint. See /docs or GET /v1/meta.');
      if (method !== 'GET' && method !== 'HEAD') return apiError(env, 405, 'method_not_allowed', 'Use GET or POST {"code": "..."} for the single-code endpoints, POST for /v1/batch, GET for /v1/meta.', { allow: path.startsWith('/v1/meta') ? 'GET, HEAD, OPTIONS' : 'GET, HEAD, POST, OPTIONS' });

      if (path === '/v1/meta' || path === '/v1/meta/') {
        const g = await gate(request, env, L);
        if (g.response) return g.response;
        return json(env, meta(env, L));
      }

      const m = single;
      if (!m) return apiError(env, 404, 'not_found', 'Unknown endpoint. See /docs or GET /v1/meta.');
      const type = m[1];
      const code = decodeCode(m[2] || '');
      if (code === null) return apiError(env, 400, 'bad_encoding', 'The code is not valid percent-encoding.');
      if (!code.trim()) return apiError(env, 400, 'missing_code', `Put the code in the path, e.g. /v1/${type}/${exampleFor(type)}, or POST /v1/${type} with {"code": "..."}`);
      if (code.length > MAX_CODE_LENGTH) return apiError(env, 400, 'input_too_long', `Codes are at most ${MAX_CODE_LENGTH} characters.`);
      const g = await gate(request, env, L);
      if (g.response) return g.response;
      const charged = await chargeQuotaAndPool(env, ctx, L, g.rec, 1);
      if (charged.response) return charged.response;
      const r = type === 'detect' ? detect(code) : VALIDATORS[type](code);
      return json(env, r, 200, charged.headers);
    } catch (e) {
      if (e instanceof BodyError) return apiError(env, e.status, e.code, e.message);
      return apiError(env, 500, 'internal_error', 'Something went wrong. Please retry.');
    }
  }
  return handle;
}

const TYPES = ['auto', 'iban', 'bic', 'vat', 'gtin', 'isbn'];
function batchItem(item, index) {
  let code = item, type = 'auto';
  if (item && typeof item === 'object' && !Array.isArray(item)) { code = item.code; type = item.type ?? 'auto'; }
  if (typeof code !== 'string') return { index, valid: false, error: 'invalid_item', reason: 'each item must be a string or {"code": "...", "type": "..."}' };
  if (!TYPES.includes(type)) return { index, input: code, valid: false, error: 'invalid_type', reason: `type must be one of ${TYPES.join(', ')}` };
  if (code.length > MAX_CODE_LENGTH) return { index, valid: false, error: 'input_too_long', reason: `codes are at most ${MAX_CODE_LENGTH} characters` };
  const r = type === 'auto' ? detect(code) : VALIDATORS[type](code);
  return { index, ...r };
}

function exampleFor(type) {
  return { iban: 'DE89370400440532013000', bic: 'DEUTDEFF', vat: 'ATU13585627', gtin: '4006381333931', isbn: '9780306406157', detect: '9780306406157' }[type];
}
