// Project-scoped credential store at ~/.config/exemplar-cli/credentials.json.
// Used by the `login` command. Env var EXEMPLAR_API_KEY always wins when set.
//
// Shape (all fields optional except savedAt):
//   { token?, refreshToken?, clientId?, clientSecret?,
//     accessToken?, expiresAt?, refreshTokenHash?, savedAt }
//
// - `token` — static bearer/api-key (single-token schemes).
// - `refreshToken`/`clientId`/`clientSecret` — OAuth-refresh long-lived creds.
// - `accessToken`/`expiresAt` — short-lived token minted from refresh creds.
// - `refreshTokenHash` — sha256 of the refresh token used to mint the cached
//   access token. Lets the auth resolver detect account switches: if the
//   current refresh token's hash doesn't match, the cached access token is
//   invalidated rather than reused under the wrong account/scope.
//
// Set <API>_NO_CACHE=1 in the environment to skip persistence entirely (the
// auth layer reads this and short-circuits saveCredentials calls).
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// Tests override via __EXEMPLAR_DEV_CONFIG_DIR to redirect to a tmp dir.
// Generated CLIs always use ~/.config/<api>-cli/ — the substitute step
// in Phase 5 inlines this constant without the env fallback.
const CONFIG_DIR = process.env.__EXEMPLAR_DEV_CONFIG_DIR || join(homedir(), ".config", "exemplar-cli");
const CRED_PATH = join(CONFIG_DIR, "credentials.json");

export function loadCredentials() {
  if (!existsSync(CRED_PATH)) return null;
  try { return JSON.parse(readFileSync(CRED_PATH, "utf8")); }
  catch { return null; }
}

export function saveCredentials(creds) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
  try { chmodSync(CRED_PATH, 0o600); } catch { /* non-POSIX */ }
}

export function clearCredentials() {
  if (existsSync(CRED_PATH)) {
    try { unlinkSync(CRED_PATH); } catch { /* ignore */ }
  }
}

export function credentialsPath() { return CRED_PATH; }

export function hashRefreshToken(refreshToken) {
  if (!refreshToken) return null;
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}
