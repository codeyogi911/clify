// `login` is the auth-management command, not a REST resource. It lives
// outside the resource registry and is dispatched directly by bin/exemplar-cli.mjs.
//
// Mirrors the agents-cli pattern: `<cli> login [--token <t>]` stores a token at
// ~/.config/exemplar-cli/credentials.json. `<cli> login --status` reports
// whether the env var or stored token (or neither) is providing auth.
import { saveCredentials, credentialsPath } from "../lib/config.mjs";
import { authStatus } from "../lib/auth.mjs";
import { output, errorOut } from "../lib/output.mjs";

export const loginFlags = {
  token: { type: "string", description: "API token to persist (omit to read interactively)" },
  status: { type: "boolean", description: "Show current auth source without changing it" },
};

export async function runLogin(values, jsonRequested) {
  if (values.status) {
    output(authStatus(), jsonRequested);
    return;
  }
  let token = values.token;
  if (!token) token = (process.env.EXEMPLAR_LOGIN_TOKEN || "").trim();
  if (!token) {
    errorOut("validation_error", "Pass --token <value>, set EXEMPLAR_LOGIN_TOKEN, or set EXEMPLAR_API_KEY in your environment.");
  }
  saveCredentials({ token, savedAt: new Date().toISOString() });
  output({ ok: true, path: credentialsPath() }, jsonRequested);
}
