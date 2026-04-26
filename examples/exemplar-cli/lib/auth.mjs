// Pluggable auth resolver. The exemplar uses bearer; the scaffolder swaps
// `SCHEME` (and substitutes the matching constants below) for the target API.
//
// Schemes the validation gate accepts:
//   bearer          static bearer token in `Authorization: Bearer <t>`
//   api-key-header  static token in `X-Api-Key: <t>` (header name fixed)
//   basic           static `user:password` in `Authorization: Basic <b64>`
//   none            no auth (open API)
//   oauth-refresh   POST refresh-token to TOKEN_URL, cache short-lived access
//                   token, re-mint on expiry. Substitute TOKEN_URL + the
//                   *_REFRESH_TOKEN/_CLIENT_ID/_CLIENT_SECRET env names.
//
// To add a new scheme: add a branch in `applyAuth`, set headers, return
// { ok, reason }. Don't fork apiRequest.
import { loadCredentials, saveCredentials, hashRefreshToken } from "./config.mjs";

// SCHEME is a build-time constant in generated CLIs. The exemplar uses an
// env-fallback so the test suite can drive every branch (bearer, api-key,
// basic, oauth-refresh) without forking the file. The Phase 5 substitution
// REPLACES this entire line with `const SCHEME = "<chosen>"` — generated
// CLIs never honor __EXEMPLAR_DEV_SCHEME.
const SCHEME = process.env.__EXEMPLAR_DEV_SCHEME || "bearer";
const ENV_VAR = "EXEMPLAR_API_KEY";

// OAuth-refresh substitution targets. The skill rewrites these per API:
// e.g. TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token", and the env
// names get the API prefix (ZOHO_INVENTORY_REFRESH_TOKEN, …). The wire
// prefix on the access token defaults to `Bearer` but can be overridden
// (Zoho uses `Zoho-oauthtoken`) by editing OAUTH_WIRE_PREFIX below.
// Tests override via EXEMPLAR_TOKEN_URL to point at the mock server.
const TOKEN_URL = (process.env.EXEMPLAR_TOKEN_URL || "https://api.exemplar.test/oauth/token").replace(/\/$/, "");
const REFRESH_ENV = "EXEMPLAR_REFRESH_TOKEN";
const CLIENT_ID_ENV = "EXEMPLAR_CLIENT_ID";
const CLIENT_SECRET_ENV = "EXEMPLAR_CLIENT_SECRET";
const NO_CACHE_ENV = "EXEMPLAR_NO_CACHE";
const OAUTH_WIRE_PREFIX = "Bearer";

function noCache() {
  const v = process.env[NO_CACHE_ENV];
  return v === "1" || v === "true";
}

async function refreshAccessToken({ refreshToken, clientId, clientSecret }) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  let res;
  try {
    res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
  } catch (err) {
    return { ok: false, reason: `oauth refresh network error: ${err.message}` };
  }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!res.ok || !parsed?.access_token) {
    return { ok: false, reason: `oauth refresh failed (HTTP ${res.status}): ${parsed?.error || text.slice(0, 120)}` };
  }
  return {
    ok: true,
    accessToken: parsed.access_token,
    expiresAt: Date.now() + (Number(parsed.expires_in || 3600) - 60) * 1000,
  };
}

// Single-token resolver (bearer | api-key-header | basic).
function resolveStaticToken() {
  if (process.env[ENV_VAR]) return process.env[ENV_VAR];
  const creds = loadCredentials();
  return creds?.token || null;
}

// OAuth-refresh resolver. Precedence (top wins):
//   1. process.env[ENV_VAR]                   — pre-minted access token.
//   2. env refresh creds → mint                — env always trumps cache.
//   3. cached access token                     — only if its refreshTokenHash
//                                                matches the current source's
//                                                refresh token hash.
//   4. stored refresh creds → mint
//   5. fail with auth_missing.
async function resolveOAuthToken() {
  if (process.env[ENV_VAR]) return { token: process.env[ENV_VAR], source: "env" };

  const stored = loadCredentials() || {};
  const envRefresh = process.env[REFRESH_ENV];
  const envClientId = process.env[CLIENT_ID_ENV];
  const envClientSecret = process.env[CLIENT_SECRET_ENV];
  const haveEnvOAuth = envRefresh && envClientId && envClientSecret;
  const haveStoredOAuth = stored.refreshToken && stored.clientId && stored.clientSecret;

  // Determine the active refresh source — env wins.
  let source, creds;
  if (haveEnvOAuth) {
    source = "env";
    creds = { refreshToken: envRefresh, clientId: envClientId, clientSecret: envClientSecret };
  } else if (haveStoredOAuth) {
    source = "config";
    creds = { refreshToken: stored.refreshToken, clientId: stored.clientId, clientSecret: stored.clientSecret };
  } else if (stored.token) {
    return { token: stored.token, source: "config" }; // legacy static token from `login --token`
  } else {
    return { token: null, source: null };
  }

  // Reuse cache only if it was minted from the same refresh token (account match).
  const currentHash = hashRefreshToken(creds.refreshToken);
  if (
    stored.accessToken &&
    stored.expiresAt &&
    Date.now() < stored.expiresAt &&
    stored.refreshTokenHash === currentHash
  ) {
    return { token: stored.accessToken, source: "cache" };
  }

  const refreshed = await refreshAccessToken(creds);
  if (!refreshed.ok) return { token: null, source: null, error: refreshed.reason };

  if (!noCache()) {
    saveCredentials({
      ...stored,
      refreshToken: creds.refreshToken,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
      refreshTokenHash: currentHash,
      savedAt: new Date().toISOString(),
    });
  }
  return { token: refreshed.accessToken, source: source === "env" ? "refreshed-env" : "refreshed-config" };
}

export async function applyAuth(headers) {
  if (SCHEME === "none") return { ok: true };

  if (SCHEME === "oauth-refresh") {
    const { token, error } = await resolveOAuthToken();
    if (!token) return { ok: false, reason: error || "auth_missing" };
    headers["authorization"] = `${OAUTH_WIRE_PREFIX} ${token}`;
    return { ok: true };
  }

  const token = resolveStaticToken();
  if (!token) return { ok: false, reason: "auth_missing" };
  if (SCHEME === "bearer") {
    headers["authorization"] = `Bearer ${token}`;
  } else if (SCHEME === "api-key-header") {
    headers["x-api-key"] = token;
  } else if (SCHEME === "basic") {
    headers["authorization"] = `Basic ${Buffer.from(token).toString("base64")}`;
  }
  return { ok: true };
}

export function authStatus() {
  const stored = loadCredentials() || {};
  if (SCHEME === "oauth-refresh") {
    const fromEnvAccess = !!process.env[ENV_VAR];
    const fromEnvOAuth = !!(process.env[REFRESH_ENV] && process.env[CLIENT_ID_ENV] && process.env[CLIENT_SECRET_ENV]);
    const fromConfigOAuth = !!(stored.refreshToken && stored.clientId && stored.clientSecret);
    const hasCachedAccess = !!(stored.accessToken && stored.expiresAt && Date.now() < stored.expiresAt);
    return {
      scheme: SCHEME,
      envVar: ENV_VAR,
      fromEnv: fromEnvAccess,
      fromEnvOAuth,
      fromConfigOAuth,
      fromConfig: !!stored.token || hasCachedAccess,
      hasCachedAccess,
      cachedExpiresAt: stored.expiresAt || null,
      noCache: noCache(),
      authenticated: fromEnvAccess || fromEnvOAuth || fromConfigOAuth || !!stored.token,
    };
  }
  const fromEnv = !!process.env[ENV_VAR];
  const fromConfig = !!stored.token;
  return { scheme: SCHEME, envVar: ENV_VAR, fromEnv, fromConfig, authenticated: fromEnv || fromConfig };
}
