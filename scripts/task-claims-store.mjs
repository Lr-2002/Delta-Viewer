import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import path from "node:path";

export function validateBatchKey(key) {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw Error("BATCH_KEY_INVALID");
  return key;
}

export function openTaskClaims(dataRoot) {
  const file = path.join(dataRoot, "task-claims.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS claims (
      batch_key TEXT PRIMARY KEY, username TEXT NOT NULL,
      display_name TEXT NOT NULL, claimed_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claim_history (
      id INTEGER PRIMARY KEY, batch_key TEXT NOT NULL, actor TEXT NOT NULL,
      action TEXT NOT NULL, previous_owner TEXT, next_owner TEXT, occurred_at_ms INTEGER NOT NULL
    );`);
  const read = db.prepare("SELECT batch_key AS batchKey, username, display_name AS displayName, claimed_at_ms AS claimedAtMs FROM claims WHERE batch_key = ?");
  function mutate(key, actor, action, target) {
    validateBatchKey(key);
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = read.get(key);
      if (action === "claim" && previous) {
        db.exec("COMMIT");
        return { conflict: previous.username !== actor.username, claim: previous };
      }
      if (target) {
        db.prepare("INSERT INTO claims VALUES (?, ?, ?, ?) ON CONFLICT(batch_key) DO UPDATE SET username=excluded.username, display_name=excluded.display_name, claimed_at_ms=excluded.claimed_at_ms")
          .run(key, target.username, target.displayName, Date.now());
      } else db.prepare("DELETE FROM claims WHERE batch_key = ?").run(key);
      db.prepare("INSERT INTO claim_history (batch_key, actor, action, previous_owner, next_owner, occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(key, actor.username, action, previous?.username ?? null, target?.username ?? null, Date.now());
      const result = read.get(key) ?? null;
      db.exec("COMMIT");
      return { conflict: false, claim: result };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    lookup(keys) {
      if (!Array.isArray(keys) || keys.length > 1000) throw Error("BATCH_KEYS_INVALID");
      return keys.map(validateBatchKey).map((key) => read.get(key)).filter(Boolean);
    },
    claim: (key, actor) => mutate(key, actor, "claim", actor),
    release: (key, actor) => mutate(key, actor, "release", null),
    transfer: (key, actor, target) => mutate(key, actor, "transfer", target),
    close: () => db.close(),
  };
}
