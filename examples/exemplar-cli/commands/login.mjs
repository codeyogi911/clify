// `login` is the auth-management command, not a REST resource. It lives
// outside the resource registry and is dispatched directly by bin/exemplar-cli.mjs.
//
// Two modes (mutually exclusive):
//   --token <t>                                          static-token schemes
//   --refresh-token <r> --client-id <i> --client-secret <s>   oauth-refresh
//
// Both persist to ~/.config/exemplar-cli/credentials.json. `--status` reports
// the current auth source without changing it.
import { saveCredentials, credentialsPath, loadCredentials, hashRefreshToken } from "../lib/config.mjs";
import { authStatus } from "../lib/auth.mjs";
import { output, errorOut } from "../lib/output.mjs";

export const loginFlags = {
  token: { type: "string", description: "Static API token to persist (bearer/api-key/basic schemes)" },
  "refresh-token": { type: "string", description: "OAuth refresh token (oauth-refresh scheme)" },
  "client-id": { type: "string", description: "OAuth client id (oauth-refresh scheme)" },
  "client-secret": { type: "string", description: "OAuth client secret (oauth-refresh scheme)" },
  status: { type: "boolean", description: "Show current auth source without changing it" },
};

export async function runLogin(values, jsonRequested) {
  if (values.status) {
    output(authStatus(), jsonRequested);
    return;
  }

  const refreshToken = values["refresh-token"];
  const clientId = values["client-id"];
  const clientSecret = values["client-secret"];
  const oauthFlags = [refreshToken, clientId, clientSecret];
  const oauthCount = oauthFlags.filter(Boolean).length;
  const hasToken = !!values.token;

  if (hasToken && oauthCount > 0) {
    errorOut("validation_error", "Pass either --token (static) OR --refresh-token+--client-id+--client-secret (OAuth), not both.");
  }

  // OAuth path — all three OAuth flags must be present together.
  if (oauthCount > 0) {
    if (oauthCount !== 3) {
      errorOut("validation_error", "OAuth login requires --refresh-token AND --client-id AND --client-secret.");
    }
    const stored = loadCredentials() || {};
    saveCredentials({
      ...stored,
      refreshToken,
      clientId,
      clientSecret,
      refreshTokenHash: hashRefreshToken(refreshToken),
      // Drop any stale cached access token; it'll be minted on next request.
      accessToken: undefined,
      expiresAt: undefined,
      savedAt: new Date().toISOString(),
    });
    output({ ok: true, mode: "oauth-refresh", path: credentialsPath() }, jsonRequested);
    return;
  }

  // Static-token path.
  let token = values.token;
  if (!token) token = (process.env.EXEMPLAR_LOGIN_TOKEN || "").trim();
  if (!token) {
    errorOut(
      "validation_error",
      "Pass --token <value>, set EXEMPLAR_LOGIN_TOKEN, or set EXEMPLAR_API_KEY in your environment. For OAuth APIs use --refresh-token --client-id --client-secret instead.",
    );
  }
  saveCredentials({ token, savedAt: new Date().toISOString() });
  output({ ok: true, mode: "static", path: credentialsPath() }, jsonRequested);
}
