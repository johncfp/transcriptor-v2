import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Google sign-in for a desktop app: OAuth 2.0 with PKCE and a loopback
 * redirect (https://developers.google.com/identity/protocols/oauth2/native-app).
 * The browser opens Google's consent page; Google redirects to a one-off
 * local port with a code, which is exchanged for tokens.
 *
 * NOT IN USE YET (M5 is built but switched off). Before turning it on:
 * 1. Create an OAuth client of type "Desktop app" in a Google Cloud project
 *    owned by the team's Workspace, and set the consent screen to Internal.
 *    Internal apps skip Google's verification and the 7-day token expiry
 *    that applies to unverified external apps.
 * 2. Put its client id and secret in GOOGLE_OAUTH below. For desktop apps
 *    Google doesn't treat the secret as confidential; PKCE protects the flow.
 */
export const GOOGLE_OAUTH = {
  clientId: "",
  clientSecret: "",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  /**
   * Read-only access to all of the user's Drive files. It's a "restricted"
   * scope, which is why the app must be Internal to the Workspace. The
   * narrower drive.file scope can't see files other tools upload.
   */
  scope: "https://www.googleapis.com/auth/drive.readonly",
};

export interface GoogleTokens {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken: string;
}

export const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE pair: a random verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizationUrl(p: { redirectUri: string; challenge: string; state: string }): string {
  const q = new URLSearchParams({
    client_id: GOOGLE_OAUTH.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH.scope,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    state: p.state,
    // A refresh token, so the watcher keeps working without signing in again.
    access_type: "offline",
    prompt: "consent",
  });
  return `${GOOGLE_OAUTH.authUrl}?${q}`;
}

async function tokenRequest(body: Record<string, string>, tokenUrl = GOOGLE_OAUTH.tokenUrl): Promise<Record<string, unknown>> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason = typeof data.error_description === "string" ? data.error_description : String(data.error ?? res.status);
    throw new Error(`Google sign-in failed: ${reason}`);
  }
  return data;
}

/**
 * Run the whole sign-in: listen on a loopback port, open the consent page
 * with `openBrowser`, wait for the redirect, exchange the code.
 */
export async function signIn(openBrowser: (url: string) => Promise<void>, timeoutMs = 5 * 60_000): Promise<GoogleTokens> {
  if (!GOOGLE_OAUTH.clientId) throw new Error("Google Drive isn't set up in this build yet.");
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));

  const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    let redirectUri = "";
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        ok
          ? "<p>Signed in. You can close this tab and go back to Transcriptor 2.</p>"
          : "<p>Sign-in didn't complete. Go back to Transcriptor 2 and try again.</p>",
      );
      clearTimeout(timer);
      server.close();
      if (ok) resolve({ code: url.searchParams.get("code")!, redirectUri });
      else reject(new Error(url.searchParams.get("error") === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in failed."));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Google sign-in timed out."));
    }, timeoutMs);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      openBrowser(authorizationUrl({ redirectUri, challenge, state })).catch(reject);
    });
  });

  const data = await tokenRequest({
    client_id: GOOGLE_OAUTH.clientId,
    client_secret: GOOGLE_OAUTH.clientSecret,
    code: code.code,
    code_verifier: verifier,
    redirect_uri: code.redirectUri,
    grant_type: "authorization_code",
  });
  if (typeof data.refresh_token !== "string") throw new Error("Google didn't grant offline access. Try signing in again.");
  return {
    accessToken: String(data.access_token),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    refreshToken: data.refresh_token,
  };
}

/** A fresh access token from a refresh token. */
export async function refreshTokens(tokens: GoogleTokens, tokenUrl?: string): Promise<GoogleTokens> {
  const data = await tokenRequest(
    {
      client_id: GOOGLE_OAUTH.clientId,
      client_secret: GOOGLE_OAUTH.clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    },
    tokenUrl,
  );
  return {
    accessToken: String(data.access_token),
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    refreshToken: tokens.refreshToken,
  };
}
