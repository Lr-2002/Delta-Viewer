// A desktop process keeps its bearer in memory. The server persists only its hash,
// so an open app can renew after sleep/reconnect or a service restart, without a password.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const SESSION_CONTINUITY_CAPABILITY = "slidingSessionsV1";
export const DEFAULT_SESSION_IDLE_SECONDS = 30 * 24 * 3600;
const hash = value => createHash("sha256").update(value).digest("hex");
const validToken = token => typeof token === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(token);
// A password change or replacement account must never revive an older credential.
const credential = user => hash(JSON.stringify([
  user.username, user.createdAtMs, user.password.algorithm, user.password.salt, user.password.digest,
]));

export function openAuthSessions(dataRoot, { idleTtlSeconds = DEFAULT_SESSION_IDLE_SECONDS, clock = Date.now } = {}) {
  const file = path.join(dataRoot, "auth-sessions.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, credential TEXT NOT NULL,
      created_ms INTEGER NOT NULL, seen_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_owner ON sessions(username,created_ms);`);
  const idleMs = idleTtlSeconds * 1000;
  const touchMs = Math.min(60_000, idleMs / 4);
  function lookup(token, users) {
    if (!validToken(token)) return null;
    const key = hash(token), now = clock();
    const row = db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(key);
    if (!row) return null;
    const user = users.find(user => user.username === row.username);
    if (row.expires_ms <= now || !user || (user.accountStatus ?? "active") !== "active" || credential(user) !== row.credential) {
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(key);
      return null;
    }
    return { key, row, user, now };
  }
  return {
    create(user) {
      const token = randomBytes(32).toString("base64url"), now = clock();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM sessions WHERE expires_ms<=?").run(now);
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)").run(hash(token), user.username, credential(user), now, now, now + idleMs);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { token, expiresAtMs: now + idleMs };
    },
    authenticate(token, users) {
      const match = lookup(token, users);
      if (!match) return null;
      const { key, row, user, now } = match;
      // Coalesce disk writes; all successful polls authenticate, but need not fsync every 15 s.
      if (now - row.seen_ms >= touchMs) {
        row.expires_ms = now + idleMs;
        db.prepare("UPDATE sessions SET seen_ms=?,expires_ms=? WHERE token_hash=?").run(now, row.expires_ms, key);
      }
      return { user, expiresAtMs: row.expires_ms };
    },
    // An administrator looking at the version table must not extend a device's session.
    activeTokens(users) { return { has: token => Boolean(lookup(token, users)) }; },
    revoke(token) { if (validToken(token)) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token)); },
    revokeUsers(usernames) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const username of usernames) db.prepare("DELETE FROM sessions WHERE username=?").run(username);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close() { db.close(); },
  };
}
