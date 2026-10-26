import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const CLIENT_PRESENCE_CAPABILITY = "clientVersionRemindersV1";
export const ONLINE_WINDOW_MS = 90_000;
const TTL_MS = 7 * 24 * 3600_000;
const validId = (id) => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function openClientPresence(dataRoot, clock = Date.now) {
  const file = path.join(dataRoot, "client-presence.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS clients (
      username TEXT NOT NULL, client_id TEXT NOT NULL, version TEXT NOT NULL,
      platform TEXT NOT NULL, seen_ms INTEGER NOT NULL,
      PRIMARY KEY(username,client_id));
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, sender TEXT NOT NULL,
      created_ms INTEGER NOT NULL, acknowledged_ms INTEGER);
    CREATE INDEX IF NOT EXISTS reminder_recipient ON reminders(username,acknowledged_ms,created_ms);`);
  // Online means a fresh report in this service run, not an old persisted row.
  const live = new Map();
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function pending(username) {
    return db.prepare(`SELECT id, sender, created_ms AS createdAtMs FROM reminders
      WHERE username=? AND acknowledged_ms IS NULL AND created_ms>? ORDER BY created_ms LIMIT 1`).get(username, clock()-TTL_MS) ?? null;
  }
  return {
    poll(username, input, token) {
      if (!input || !validId(input.clientId) || (typeof input.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version))
        || !["windows", "macos", "linux"].includes(input.platform)
        || !Array.isArray(input.acknowledgedIds) || input.acknowledgedIds.length > 20
        || input.acknowledgedIds.some(id => !validId(id))) throw Error("CLIENT_REPORT_INVALID");
      const now = clock();
      transaction(() => {
        db.prepare(`INSERT INTO clients VALUES(?,?,?,?,?) ON CONFLICT(username,client_id)
          DO UPDATE SET version=excluded.version,platform=excluded.platform,seen_ms=excluded.seen_ms`)
          .run(username,input.clientId,input.version,input.platform,now);
        db.prepare(`DELETE FROM clients WHERE username=? AND client_id NOT IN
          (SELECT client_id FROM clients WHERE username=? ORDER BY seen_ms DESC LIMIT 16)`).run(username,username);
        for (const id of input.acknowledgedIds) db.prepare(`UPDATE reminders SET acknowledged_ms=?
          WHERE id=? AND username=? AND acknowledged_ms IS NULL`).run(now,id,username);
        // Keep bounded history; never touch reviewer/source audit queues.
        db.prepare("DELETE FROM reminders WHERE created_ms<?").run(now-TTL_MS);
        db.prepare("DELETE FROM clients WHERE seen_ms<?").run(now-30*24*3600_000);
      });
      live.set(`${username}:${input.clientId}`, {token,seenMs:now});
      const retained = new Set(db.prepare("SELECT client_id FROM clients WHERE username=?").all(username).map(row=>`${username}:${row.client_id}`));
      for (const [key,value] of live) if(now-value.seenMs>=ONLINE_WINDOW_MS || (key.startsWith(`${username}:`) && !retained.has(key))) live.delete(key);
      return { generatedAtMs: now, reminder: pending(username) };
    },
    overview(users, activeTokens) {
      const now=clock();
      const rows=db.prepare(`SELECT username,client_id AS clientId,version,platform,seen_ms AS lastSeenAtMs
        FROM clients ORDER BY seen_ms DESC`).all();
      return {generatedAtMs:now, users:users.map(user=>({username:user.username,
        clients:rows.filter(row=>row.username===user.username).map(row=>({...row,
          online:now-row.lastSeenAtMs<ONLINE_WINDOW_MS && activeTokens.has(live.get(`${row.username}:${row.clientId}`)?.token)})),
        pendingReminder:pending(user.username)}))};
    },
    push(sender, usernames) {
      if(!Array.isArray(usernames) || usernames.length>10_000 || new Set(usernames).size!==usernames.length) throw Error("REMINDER_TARGET_INVALID");
      return transaction(()=>({queued:usernames.map(username=>{
        // Repeated clicks don't create a popup storm while one reminder is pending.
        const previous=pending(username);
        if (previous) return {username,id:previous.id,reused:true};
        const id=randomUUID();
        db.prepare("INSERT INTO reminders VALUES(?,?,?,?,NULL)").run(id,username,sender,clock());
        return {username,id,reused:false};
      })}));
    },
    close:()=>db.close(),
  };
}
