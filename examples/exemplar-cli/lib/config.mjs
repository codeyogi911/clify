// Project-scoped credential store at ~/.config/exemplar-cli/credentials.json.
// Used by the `login` command. Env var EXEMPLAR_API_KEY always wins when set.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "exemplar-cli");
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

export function credentialsPath() { return CRED_PATH; }
