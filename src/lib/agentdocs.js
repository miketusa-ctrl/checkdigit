// llms.txt, OpenAPI 3.1 and the MCP server card, generated from code constants and limitsFor(env) (agent-ready
// recipe r2 §3/§4, Smithery §13.2). No number is hard-coded twice; drift tests in test/agent.test.js keep these in step.
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES as MCP_BODY, SERVER_INFO, RESULT_OUT, CODE_TYPES } from './mcp.js';
import { VERSION } from './version.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const mcpClientConfig = (origin) => ({ mcpServers: { checkdigit: { type: 'http', url: `${origin}/mcp` } } });
const TYPES = ['iban', 'bic', 'vat', 'gtin', 'isbn', 'detect'];

export const llmsTxt = (origin, L, X) => `# CheckDigit

> Offline format and check-digit validation for IBANs, BICs (SWIFT codes), EU VAT numbers, GTIN/EAN/UPC barcodes and ISBNs, with auto-detection. Public JSON API plus a remote MCP server for AI agents. This is a format check, not a compliance check: a valid result does not prove that an account, VAT registration, bank or product exists. Codes are checked in memory and not stored or logged.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tools: ${TOOLS.map((t) => `\`${t.name}\`${Object.keys(t.inputSchema.properties).length ? ` (${Object.keys(t.inputSchema.properties).join(', ')})` : ''}`).join(', ')}. Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [Docs](${origin}/docs): human-readable API docs

## JSON API

- \`POST ${origin}/v1/{type}\` with JSON \`{"code": "DE89370400440532013000"}\`, type = ${TYPES.join(', ')} (recommended: keeps the code out of URLs). \`GET /v1/{type}/{code}\` also works but puts the code in a URL.
- \`POST ${origin}/v1/batch\` with \`{"codes": [...]}\`: up to ${X.batchMax} codes, Pro keys only (paid plans are not on sale yet).
- \`GET ${origin}/v1/meta\`: version, supported countries and formats, limits.
- Results: type, input, normalized, valid, reason (when invalid), plus type-specific fields (country, formatted, check digits, ean13, isbn13 ...).
- Errors: { "error": { "code", "message" } } with 400 (missing_code, input_too_long, invalid_json, code_in_url, bad_encoding, invalid_batch, empty_batch, batch_too_large), 401 (invalid_api_key, api_key_required), 403 (paid_plan_required), 404 (not_found), 405 (method_not_allowed), 413 (payload_too_large), 429 (rate_limited, daily_capacity_reached, monthly_quota_exceeded), 500 (internal_error), 503 (storage_unavailable). Max code length ${X.maxCode} characters; max POST body ${X.restBodyBytes} bytes.

## Limits and keys

- Anonymous: about ${L.anonPerMin} checks/min per IP. API key (\`Authorization: Bearer cd_live_...\` or \`X-Api-Key\`, issued by request during early access): about ${L.keyPerMin}/min; free plan ${L.freePerMonth} calls per month. A shared daily capacity applies. The MCP endpoint uses the same keys and counters: each \`validate_code\` call is one check; \`get_meta\` and non-call messages don't count as checks, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After).

## Optional

- [Privacy](${origin}/docs#privacy): codes are not stored or logged. A salted, daily-rotating hash of the visitor IP is kept for up to 9 days to count unique visitors per day; no IP address is stored.
- Contact: ${CONTACT}
`;

const errSchema = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] };
const resp = (d) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const H = (d) => ({ description: d, schema: { type: 'string' } });
const okHeaders = { 'x-checkdigit-plan': H('free or pro, keyed calls only'), 'x-quota-limit': H('Monthly quota, keyed calls only'), 'x-quota-remaining': H('Calls left this month, keyed calls only') };
const r429 = { description: 'rate_limited, daily_capacity_reached or monthly_quota_exceeded', headers: { 'retry-after': H('Seconds to wait'), 'x-ratelimit-limit': H('Per-minute limit (rate_limited only)') }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema) => ({ description: 'Result', headers: okHeaders, content: { 'application/json': { schema } } });

export function openApiSpec(origin, L, X) {
  const result = { $ref: '#/components/schemas/Result' };
  const paths = {};
  for (const t of TYPES) {
    paths[`/v1/${t}`] = { post: {
      operationId: `${t}Post`, summary: t === 'detect' ? 'Auto-detect and validate one code (code in the JSON body)' : `Validate one ${t.toUpperCase()} (code in the JSON body; recommended)`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { code: { type: 'string', maxLength: X.maxCode } }, required: ['code'] } } } },
      responses: { 200: ok(result), 400: resp('missing_code, input_too_long, invalid_json or code_in_url'), 401: resp('invalid_api_key'), 413: resp('payload_too_large'), 429: r429, 500: resp('internal_error'), 503: resp('storage_unavailable') },
    } };
    paths[`/v1/${t}/{code}`] = { get: {
      operationId: `${t}Get`, summary: `Same check with the code in the path (prefer POST for IBAN/VAT)`,
      parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string', maxLength: X.maxCode } }],
      responses: { 200: ok(result), 400: resp('missing_code, input_too_long or bad_encoding'), 401: resp('invalid_api_key'), 405: resp('method_not_allowed'), 429: r429, 503: resp('storage_unavailable') },
    } };
  }
  paths['/v1/batch'] = { post: {
    operationId: 'batch', summary: `Validate up to ${X.batchMax} codes (Pro keys only; each code counts one call)`,
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { codes: { type: 'array', minItems: 1, maxItems: X.batchMax, items: { oneOf: [{ type: 'string', maxLength: X.maxCode }, { type: 'object', properties: { code: { type: 'string', maxLength: X.maxCode }, type: { type: 'string', enum: CODE_TYPES } }, required: ['code'] }] } } }, required: ['codes'] } } } },
    responses: { 200: ok({ type: 'object', properties: { count: { type: 'integer' }, valid_count: { type: 'integer' }, invalid_count: { type: 'integer' }, results: { type: 'array', items: result } } }), 400: resp('invalid_json, invalid_batch, empty_batch or batch_too_large'), 401: resp('api_key_required or invalid_api_key'), 403: resp('paid_plan_required'), 405: resp('method_not_allowed'), 413: resp('payload_too_large'), 429: r429, 503: resp('storage_unavailable') },
  } };
  paths['/v1/meta'] = { get: { operationId: 'meta', summary: 'Version, supported countries and formats, limits', responses: { 200: { description: 'Meta', content: { 'application/json': { schema: { type: 'object' } } } }, 401: resp('invalid_api_key'), 405: resp('method_not_allowed'), 429: r429 } } };
  const allow = { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } };
  paths['/mcp'] = {
    post: {
      operationId: 'mcp', summary: `MCP JSON-RPC 2.0 (Streamable HTTP, stateless). Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Max body ${MCP_BODY} bytes.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'JSON-RPC response (tool errors are results with isError)', headers: okHeaders }, 202: { description: 'Notification or client response accepted' }, 400: { description: 'Parse error, invalid request, header mismatch or unsupported version' }, 401: { description: 'invalid_api_key (no WWW-Authenticate)' }, 403: { description: 'Origin not allowed' }, 404: { description: 'Unknown method (2026-07-28)' }, 413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests or key checks', headers: { 'retry-after': H('Seconds') } }, 500: { description: 'Internal error' }, 503: { description: 'storage_unavailable' } },
    },
    get: { operationId: 'mcpGet', summary: 'Not supported (stateless, no SSE)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
    delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'CheckDigit', version: VERSION, description: `Offline format and check-digit validation for IBAN, BIC, EU VAT, GTIN/EAN/UPC and ISBN. Format check, not a compliance check. Codes are not stored or logged. Anonymous ~${L.anonPerMin}/min per IP; API key ~${L.keyPerMin}/min.`, contact: { email: CONTACT } },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'cd_live_... API key' }, apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      schemas: { Error: errSchema, Result: RESULT_OUT },
    },
    paths,
  };
}

export const serverCard = (origin) => ({
  serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: VERSION },
  transport: { type: 'streamable-http', url: `${origin}/mcp` },
  authentication: { required: false },
  tools: TOOLS, resources: [], prompts: [],
});
export const GLAMA_CLAIM = '<GLAMA_CLAIM_TOKEN>';
export const glamaJson = () => JSON.stringify({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: GLAMA_CLAIM }); // Glama connector ownership claim, served at /.well-known/glama.json. Replace the placeholder with your own claim token from glama.ai.
