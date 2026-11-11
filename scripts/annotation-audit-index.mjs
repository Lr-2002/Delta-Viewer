import { chmodSync, createReadStream, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

function updateCheckpoint(db, sourceInfo, indexedBytes) {
  db.prepare(`INSERT INTO source_checkpoint(id, dev, ino, indexed_bytes)
    VALUES(1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET dev=excluded.dev, ino=excluded.ino, indexed_bytes=excluded.indexed_bytes`)
    .run(String(sourceInfo.dev), String(sourceInfo.ino), indexedBytes);
}

async function indexCompleteLines(source, startOffset, indexEvent) {
  const stream = createReadStream(source, { start: startOffset });
  let pending = Buffer.alloc(0);
  let consumedBytes = 0;
  for await (const chunk of stream) {
    const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let lineStart = 0;
    while (true) {
      const newline = bytes.indexOf(10, lineStart);
      if (newline < 0) break;
      let line = bytes.subarray(lineStart, newline);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length) indexEvent(JSON.parse(line.toString("utf8")));
      lineStart = newline + 1;
    }
    consumedBytes += lineStart;
    pending = bytes.subarray(lineStart);
  }
  if (pending.toString("utf8").trim()) {
    indexEvent(JSON.parse(pending.toString("utf8")));
    consumedBytes += pending.length;
  }
  return startOffset + consumedBytes;
}

export async function openAnnotationAuditIndex(dataRoot) {
  const filename = path.join(dataRoot, "annotation-audit-index.sqlite");
  const source = path.join(dataRoot, "annotation-audit.jsonl");
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  if (db.prepare("PRAGMA user_version").get().user_version !== 2) {
    db.exec("DROP TABLE IF EXISTS event_ids; DROP TABLE IF EXISTS annotation_completions; DROP TABLE IF EXISTS source_checkpoint; DROP TABLE IF EXISTS annotation_activity; DROP TABLE IF EXISTS task_durations; PRAGMA user_version=2;");
  }
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS event_ids(event_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS annotation_completions(
      username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      trajectory_code TEXT NOT NULL,
      saved_at_ms INTEGER NOT NULL,
      saved_seq INTEGER NOT NULL,
      duration_ms INTEGER,
      PRIMARY KEY(username, task_id, trajectory_code)
    );
    CREATE TABLE IF NOT EXISTS annotation_activity(
      seq INTEGER PRIMARY KEY,
      event_id TEXT UNIQUE,
      username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      trajectory_code TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_by_user_date ON annotation_activity(username, occurred_at_ms);
    CREATE INDEX IF NOT EXISTS activity_by_trajectory ON annotation_activity(username, task_id, trajectory_code, action, occurred_at_ms, seq);
    CREATE TABLE IF NOT EXISTS task_durations(
      username TEXT NOT NULL,
      task_id TEXT NOT NULL,
      duration_count INTEGER NOT NULL,
      duration_sum_ms INTEGER NOT NULL,
      PRIMARY KEY(username, task_id)
    );
    CREATE TABLE IF NOT EXISTS source_checkpoint(
      id INTEGER PRIMARY KEY CHECK(id=1),
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      indexed_bytes INTEGER NOT NULL
    );`);
  const insertEventId = db.prepare("INSERT OR IGNORE INTO event_ids(event_id) VALUES(?)");
  const insertActivity = db.prepare(`INSERT OR IGNORE INTO annotation_activity(event_id, username, task_id, trajectory_code, action, occurred_at_ms, payload)
    VALUES(?, ?, ?, ?, ?, ?, ?)`);
  const getCompletion = db.prepare(`SELECT saved_at_ms, saved_seq, duration_ms FROM annotation_completions
    WHERE username=? AND task_id=? AND trajectory_code=?`);
  const latestStart = db.prepare(`SELECT occurred_at_ms FROM annotation_activity
    WHERE username=? AND task_id=? AND trajectory_code=? AND action='annotation_started'
      AND (occurred_at_ms<? OR (occurred_at_ms=? AND seq<?))
    ORDER BY occurred_at_ms DESC, seq DESC LIMIT 1`);
  const setCompletion = db.prepare(`INSERT INTO annotation_completions(username, task_id, trajectory_code, saved_at_ms, saved_seq, duration_ms)
    VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(username, task_id, trajectory_code)
    DO UPDATE SET saved_at_ms=excluded.saved_at_ms, saved_seq=excluded.saved_seq, duration_ms=excluded.duration_ms`);
  const adjustDuration = db.prepare(`INSERT INTO task_durations(username, task_id, duration_count, duration_sum_ms)
    VALUES(?, ?, ?, ?) ON CONFLICT(username, task_id) DO UPDATE SET
      duration_count=duration_count+excluded.duration_count, duration_sum_ms=duration_sum_ms+excluded.duration_sum_ms`);
  function indexEvent(event) {
    const username = String(event.username ?? "").trim().toLowerCase();
    const taskId = String(event.taskId ?? "").trim().toLowerCase();
    const trajectoryCode = String(event.trajectoryCode ?? "").trim().toLowerCase();
    const eventId = typeof event.eventId === "string" && event.eventId ? event.eventId : null;
    const added = insertActivity.run(eventId, username, taskId, trajectoryCode, event.action ?? "", event.occurredAtMs ?? 0, JSON.stringify(event));
    if (eventId) insertEventId.run(eventId);
    if (!added.changes || !username || !event.trajectoryCode || !["annotation_saved", "annotation_started"].includes(event.action)) return;
    const previous = getCompletion.get(username, taskId, trajectoryCode);
    if (!previous && event.action !== "annotation_saved") return;
    let savedAt = previous?.saved_at_ms;
    let savedSeq = previous?.saved_seq;
    if (event.action === "annotation_saved" && (savedAt === undefined || event.occurredAtMs < savedAt)) {
      savedAt = event.occurredAtMs;
      savedSeq = Number(added.lastInsertRowid);
    }
    const started = latestStart.get(username, taskId, trajectoryCode, savedAt, savedAt, savedSeq);
    const duration = started ? savedAt - started.occurred_at_ms : null;
    setCompletion.run(username, taskId, trajectoryCode, savedAt, savedSeq, duration);
    const previousDuration = previous?.duration_ms ?? null;
    if (duration !== previousDuration) {
      adjustDuration.run(username, taskId, Number(duration !== null) - Number(previousDuration !== null), (duration ?? 0) - (previousDuration ?? 0));
    }
  }
  const clearIndex = () => db.exec("DELETE FROM event_ids; DELETE FROM annotation_completions; DELETE FROM source_checkpoint; DELETE FROM annotation_activity; DELETE FROM task_durations;");
  async function refresh() {
    const sourceInfo = existsSync(source) ? statSync(source) : null;
    const checkpoint = db.prepare("SELECT dev, ino, indexed_bytes FROM source_checkpoint WHERE id=1").get();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!sourceInfo) {
        clearIndex();
      } else {
        const canResume = checkpoint
          && checkpoint.dev === String(sourceInfo.dev)
          && checkpoint.ino === String(sourceInfo.ino)
          && checkpoint.indexed_bytes <= sourceInfo.size;
        if (!canResume) clearIndex();
        const indexedBytes = await indexCompleteLines(source, canResume ? checkpoint.indexed_bytes : 0, indexEvent);
        const finalInfo = statSync(source);
        if (String(finalInfo.dev) !== String(sourceInfo.dev)
          || String(finalInfo.ino) !== String(sourceInfo.ino)
          || finalInfo.size < indexedBytes) throw new Error("ANNOTATION_AUDIT_CHANGED_DURING_INDEX");
        updateCheckpoint(db, finalInfo, indexedBytes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  try { await refresh(); } catch (error) { db.close(); throw error; }

  // Readers must not see the writer's partial transaction while streaming a tail.
  const reader = new DatabaseSync(filename, { readOnly: true });
  const lookup = reader.prepare("SELECT 1 FROM event_ids WHERE event_id=?");
  const completionCount = reader.prepare(`SELECT COUNT(*) AS count FROM annotation_completions
    WHERE username=? AND task_id=?`);
  const activity = reader.prepare(`SELECT payload FROM annotation_activity
    WHERE username=? AND occurred_at_ms>=? AND occurred_at_ms<? ORDER BY seq DESC LIMIT 500`);
  const taskAverage = reader.prepare("SELECT duration_count, duration_sum_ms FROM task_durations WHERE username=? AND task_id=?");
  const userAverage = reader.prepare("SELECT SUM(duration_count) AS duration_count, SUM(duration_sum_ms) AS duration_sum_ms FROM task_durations WHERE username=?");

  return {
    has(eventId) { return Boolean(lookup.get(eventId)); },
    // The JSONL append is the durable source of truth. Read all bytes since the
    // committed checkpoint, including a previous append whose index update failed.
    async add() { await refresh(); },
    completionCount(username, taskId) {
      return Number(completionCount.get(String(username).trim().toLowerCase(), String(taskId).trim().toLowerCase()).count);
    },
    activity(username, startMs, endMs) {
      return activity.all(String(username).trim().toLowerCase(), startMs, endMs).map((row) => JSON.parse(row.payload));
    },
    averageCompletionMs(username, taskId) {
      const normalized = String(username).trim().toLowerCase();
      let row = taskAverage.get(normalized, String(taskId).trim().toLowerCase());
      if (!row?.duration_count) row = userAverage.get(normalized);
      return row?.duration_count ? Math.round(row.duration_sum_ms / row.duration_count) : null;
    },
    close() { reader.close(); db.close(); },
  };
}
