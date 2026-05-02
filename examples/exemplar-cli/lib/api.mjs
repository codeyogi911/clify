// HTTP layer: apiRequest + REST/GraphQL pagination iterators.
//
// `apiRequest` is the only place that talks to fetch(). It handles auth
// injection, multipart uploads, dry-run mode, verbose logging, and maps
// HTTP status to the structured error codes documented in conventions.md.
// GraphQL helpers intentionally delegate through it so generated GraphQL-first
// CLIs keep the same auth, redaction, BASE_URL override, and error behaviour.
import { readFileSync, existsSync } from "node:fs";
import { errorOut } from "./output.mjs";
import { applyAuth } from "./auth.mjs";

export const BASE_URL = (process.env.EXEMPLAR_BASE_URL || "https://api.exemplar.test").replace(/\/$/, "");

// Header keys that always carry credentials. Always redacted in dry-run
// output unless `showSecrets` is explicitly true.
const SECRET_HEADER_KEYS = new Set(["authorization", "x-api-key", "proxy-authorization", "cookie", "set-cookie"]);
const SECRET_KEY_PATTERN = /(token|secret|key|cookie|auth|password)/i;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (SECRET_HEADER_KEYS.has(lower) || SECRET_KEY_PATTERN.test(lower)) {
      out[k] = "<redacted>";
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function apiRequest({ method, path, query, body, headers = {}, dryRun, verbose, idempotencyKey, ifMatch, file, version = "0.0.0", showSecrets = false }) {
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const reqHeaders = { "user-agent": `exemplar-cli/${version}`, ...headers };
  const auth = await applyAuth(reqHeaders);
  if (!auth.ok) {
    const detail = auth.reason && auth.reason !== "auth_missing" ? ` (${auth.reason})` : "";
    errorOut("auth_missing", `Set EXEMPLAR_API_KEY (or run 'exemplar-cli login') to authenticate.${detail}`);
  }

  let reqBody;
  if (file) {
    if (!existsSync(file)) errorOut("validation_error", `File not found: ${file}`);
    const fd = new FormData();
    const buf = readFileSync(file);
    const blob = new Blob([buf]);
    fd.append("file", blob, file.split("/").pop());
    reqBody = fd;
  } else if (body !== undefined && method !== "GET" && method !== "DELETE") {
    reqHeaders["content-type"] = "application/json";
    reqBody = JSON.stringify(body);
  }

  if (idempotencyKey) reqHeaders["idempotency-key"] = idempotencyKey;
  if (ifMatch) reqHeaders["if-match"] = ifMatch;

  if (dryRun) {
    const safeHeaders = showSecrets ? reqHeaders : redactHeaders(reqHeaders);
    return { __dryRun: true, method, url: url.toString(), headers: safeHeaders, body: body ?? null };
  }

  let res;
  try {
    res = await fetch(url, { method, headers: reqHeaders, body: reqBody });
  } catch (err) {
    if (err.name === "AbortError" || /timeout/i.test(err.message || "")) {
      errorOut("timeout", `Request timed out: ${err.message}`, { retryable: true });
    }
    errorOut("network_error", `Network error: ${err.message}`, { retryable: true });
  }

  const status = res.status;
  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  let parsed;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (verbose) {
    const headerObj = {};
    res.headers.forEach((v, k) => { headerObj[k] = v; });
    process.stderr.write(JSON.stringify({ status, headers: headerObj }) + "\n");
  }

  if (status >= 200 && status < 300) return parsed;

  const baseMsg = parsed && typeof parsed === "object" && parsed.message ? parsed.message : `HTTP ${status}`;
  if (status === 401) errorOut("auth_invalid", baseMsg);
  if (status === 403) errorOut("forbidden", baseMsg);
  if (status === 404) errorOut("not_found", baseMsg);
  if (status === 409) errorOut("conflict", baseMsg);
  if (status === 400 || status === 422) errorOut("validation_error", baseMsg, { details: parsed });
  if (status === 429) errorOut("rate_limited", `Rate limited.${retryAfter ? ` Retry after ${retryAfter}s.` : ""}`, { retryable: true, retryAfter });
  if (status >= 500) errorOut("server_error", baseMsg, { retryable: true, retryAfter });
  errorOut("network_error", baseMsg);
}

export async function graphqlRequest({ path = "/graphql", query, variables = {}, headers = {}, dryRun, verbose, idempotencyKey, ifMatch, version = "0.0.0", showSecrets = false }) {
  if (!query) errorOut("validation_error", "GraphQL action missing query");
  const result = await apiRequest({
    method: "POST",
    path,
    body: { query, variables },
    headers,
    dryRun,
    verbose,
    idempotencyKey,
    ifMatch,
    version,
    showSecrets,
  });
  if (result?.__dryRun) return result;
  if (Array.isArray(result?.errors) && result.errors.length) {
    errorOut("validation_error", result.errors[0]?.message || "GraphQL error", { details: result.errors });
  }
  return result?.data ?? result;
}

// Cursor-pagination iterator. Server convention: list responses carry
// `{ items: [...], nextCursor: "..." | null }`. When `nextCursor` is null
// or absent, iteration stops. Used by list actions when --all is set.
export async function* paginate(opts) {
  let cursor = opts.query?.cursor;
  while (true) {
    const query = { ...(opts.query || {}) };
    if (cursor) query.cursor = cursor; else delete query.cursor;
    const res = await apiRequest({ ...opts, query });
    const page = Array.isArray(res) ? { items: res, nextCursor: null } : (res || { items: [], nextCursor: null });
    for (const item of (page.items || [])) yield item;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

// GraphQL connection-pagination iterator. Generated GraphQL-first CLIs set
// `paginatePath` to a dotted path in the response data, such as "products" or
// "shop.orders". The node at that path must expose pageInfo plus nodes/edges.
export async function* paginateGraphql({ path = "/graphql", query, variables = {}, paginatePath, pageSize = 50, dryRun, verbose, idempotencyKey, ifMatch, version = "0.0.0", showSecrets = false }) {
  if (!paginatePath) errorOut("validation_error", "GraphQL pagination missing paginatePath");
  let cursor = variables.after || null;
  while (true) {
    const vars = { ...variables };
    if (vars.first === undefined && pageSize) vars.first = pageSize;
    if (cursor) vars.after = cursor;
    else delete vars.after;

    const data = await graphqlRequest({ path, query, variables: vars, dryRun, verbose, idempotencyKey, ifMatch, version, showSecrets });
    if (data?.__dryRun) { yield data; return; }

    const connection = paginatePath.split(".").reduce((obj, key) => (obj ? obj[key] : undefined), data);
    if (!connection) return;
    const items = connection.nodes || (connection.edges ? connection.edges.map((edge) => edge.node) : []);
    for (const item of items) yield item;
    if (!connection.pageInfo?.hasNextPage) return;
    cursor = connection.pageInfo.endCursor;
  }
}
