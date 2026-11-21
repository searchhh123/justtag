import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

/**
 * "Sign in with X" (OAuth 2.0 Authorization Code + PKCE). We only need to know which X account the visitor
 * controls, so the scopes are read-only. The session then lets them link a wallet to their X handle.
 */

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const ME = "https://api.x.com/2/users/me";

export const redirectUri = () => `${config.origin}/auth/x/callback`;

export type Session = { state?: string; verifier?: string; returnTo?: string; handle?: string; xUserId?: string; name?: string; avatar?: string };

export function newSession(data: Session = {}): string {
  const id = crypto.randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)").run(id, JSON.stringify(data), Date.now() + 7 * 24 * 3600_000);
  return id;
}
export function getSession(id?: string): Session | null {
  if (!id) return null;
  const row = db.prepare("SELECT data, expires_at FROM sessions WHERE id = ?").get(id) as { data: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return JSON.parse(row.data);
}
export function saveSession(id: string, data: Session) {
  db.prepare("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(data), id);
}
export function deleteSession(id: string) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function authorizeUrl(session: Session): string {
  if (!config.xClientId) throw new Error("X_OAUTH2_CLIENT_ID is not set");
  session.state = crypto.randomBytes(16).toString("base64url");
  session.verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(session.verifier).digest("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: config.xClientId,
    redirect_uri: redirectUri(),
    scope: "users.read tweet.read",
    state: session.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE}?${q}`;
}

export async function finishLogin(session: Session, code: string, state: string) {
  if (!session.state || state !== session.state || !session.verifier) throw new Error("Login expired, please try again");
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  // Confidential clients authenticate with Basic auth; public clients send client_id in the body.
  if (config.xClientSecret) headers.authorization = "Basic " + Buffer.from(`${config.xClientId}:${config.xClientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: session.verifier,
    client_id: config.xClientId!,
  });
  const tok = await fetch(TOKEN, { method: "POST", headers, body });
  if (!tok.ok) throw new Error(`X token exchange failed: ${tok.status} ${await tok.text()}`);
  const { access_token } = (await tok.json()) as { access_token: string };
  const me = await fetch(`${ME}?user.fields=profile_image_url,username,name`, { headers: { authorization: `Bearer ${access_token}` } });
  if (!me.ok) throw new Error(`X /users/me failed: ${me.status}`);
  const { data } = (await me.json()) as { data: { id: string; username: string; name: string; profile_image_url?: string } };
  session.handle = data.username.toLowerCase();
  session.xUserId = data.id;
  session.name = data.name;
  session.avatar = data.profile_image_url;
  delete session.state;
  delete session.verifier;
  db.prepare(
    "INSERT INTO accounts (handle, x_user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(handle) DO UPDATE SET x_user_id = excluded.x_user_id, updated_at = excluded.updated_at",
  ).run(session.handle, data.id, Date.now());
  return session;
}
