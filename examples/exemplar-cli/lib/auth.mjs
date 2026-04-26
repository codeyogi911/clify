// Pluggable auth resolver. The exemplar uses bearer; the scaffolder swaps
// `scheme` (and the matching `applyAuth` branch) for the target API.
//
// Schemes the validation gate accepts: bearer | api-key-header | basic | none.
// Add a new branch here and a matching .clify.json `auth.scheme` to extend.
import { loadCredentials } from "./config.mjs";

const SCHEME = "bearer";
const ENV_VAR = "EXEMPLAR_API_KEY";

export function resolveToken() {
  if (process.env[ENV_VAR]) return process.env[ENV_VAR];
  const creds = loadCredentials();
  return creds?.token || null;
}

export function applyAuth(headers) {
  const token = resolveToken();
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
  const fromEnv = !!process.env[ENV_VAR];
  const fromConfig = !!loadCredentials()?.token;
  return { scheme: SCHEME, envVar: ENV_VAR, fromEnv, fromConfig, authenticated: fromEnv || fromConfig };
}
