import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import path from "node:path";

export const REVIEW_ACTIONS = new Set([
  "loaded",
  "closed",
  "heartbeat",
  "focus",
  "blur",
  "seek",
  "drag",
  "play",
  "pause",
  "control",
  "shortcut",
  "scroll",
  "view",
  "source",
  "segment_edit",
  "segment_select",
  "label_add",
  "label_delete",
  "label_apply",
  "saved",
  "approved",
  "rejected",
  "save_failed",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fields = new Set([
  "eventId",
  "sessionId",
  "episodeKey",
  "episodeName",
  "action",
  "occurredAtMs",
  "elapsedMs",
  "details",
]);
const detailFields = new Set([
  "target",
  "value",
  "before",
  "after",
  "frameFrom",
  "frameTo",
  "mediaTimeMs",
  "durationMs",
  "segmentIndex",
  "startFrame",
  "endFrame",
  "revision",
  "reason",
  "labelId",
  "sourceName",
]);

export function validateReviewEvent(raw, now = Date.now()) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !fields.has(key))
  )
    throw new Error("REVIEW_EVENT_INVALID: 未识别的字段");
  if (
    !uuid.test(raw.eventId) ||
    !uuid.test(raw.sessionId) ||
    !/^[a-f0-9]{64}$/.test(raw.episodeKey)
  )
    throw new Error("REVIEW_EVENT_INVALID: 事件或条目标识无效");
  if (
    !REVIEW_ACTIONS.has(raw.action) ||
    typeof raw.episodeName !== "string" ||
    !raw.episodeName ||
    raw.episodeName.length > 256
  )
    throw new Error("REVIEW_EVENT_INVALID: 行为或名称无效");
  if (
    !Number.isSafeInteger(raw.occurredAtMs) ||
    raw.occurredAtMs <= 0 ||
    raw.occurredAtMs > now + 300_000 ||
    !Number.isSafeInteger(raw.elapsedMs) ||
    raw.elapsedMs < 0
  )
    throw new Error("REVIEW_EVENT_INVALID: 时间无效");
  const details = raw.details ?? {};
  if (
    !details ||
    typeof details !== "object" ||
    Array.isArray(details) ||
    Object.keys(details).some((key) => !detailFields.has(key))
  )
    throw new Error("REVIEW_EVENT_INVALID: 明细字段无效");
  for (const value of Object.values(details)) {
    if (
      typeof value === "number"
        ? !Number.isFinite(value) || value < 0
        : typeof value !== "string" || value.length > 2000
    )
      throw new Error("REVIEW_EVENT_INVALID: 明细值无效");
  }
  if (JSON.stringify(details).length > 8000)
    throw new Error("REVIEW_EVENT_INVALID: 明细过长");
  return { ...raw, details };
}

export function openReviewAuditStore(dataRoot) {
  const filename = path.join(dataRoot, "review-audit.sqlite");
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL,
      session_id TEXT NOT NULL, episode_key TEXT NOT NULL, episode_name TEXT NOT NULL,
      action TEXT NOT NULL, occurred_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
      elapsed_ms INTEGER NOT NULL, details TEXT NOT NULL, UNIQUE(username,event_id));
    CREATE INDEX IF NOT EXISTS events_user_time ON events(username,occurred_ms,id);
    CREATE INDEX IF NOT EXISTS events_session ON events(username,session_id,id);
    CREATE INDEX IF NOT EXISTS events_time ON events(occurred_ms,id);`);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events(event_id,username,display_name,session_id,episode_key,episode_name,action,occurred_ms,received_ms,elapsed_ms,details) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  );
  function append(user, batch) {
    if (!Array.isArray(batch) || !batch.length || batch.length > 20)
      throw new Error("REVIEW_EVENT_INVALID: 批次需为 1 至 20 项");
    const now = Date.now();
    const events = batch.map((event) => validateReviewEvent(event, now));
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        insert.run(
          event.eventId,
          user.username,
          user.displayName,
          event.sessionId,
          event.episodeKey,
          event.episodeName,
          event.action,
          event.occurredAtMs,
          now,
          event.elapsedMs,
          JSON.stringify(event.details),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { eventIds: events.map((event) => event.eventId) };
  }
  function query(input, accounts) {
    const terms = ["1=1"],
      args = [];
    for (const [field, column] of [
      ["username", "username"],
      ["sessionId", "session_id"],
      ["episodeKey", "episode_key"],
      ["action", "action"],
    ]) {
      if (input[field]) {
        terms.push(`${column}=?`);
        args.push(String(input[field]));
      }
    }
    for (const [field, operator] of [
      ["fromMs", ">="],
      ["toMs", "<="],
    ]) {
      if (input[field]) {
        const number = Number(input[field]);
        if (!Number.isSafeInteger(number) || number < 0)
          throw new Error("REVIEW_QUERY_INVALID: 时间范围无效");
        terms.push(`occurred_ms${operator}?`);
        args.push(number);
      }
    }
    const where = terms.join(" AND ");
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 100));
    const before = Number(input.before) || Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || !Number.isInteger(limit) || before < 1)
      throw new Error("REVIEW_QUERY_INVALID: 分页无效");
    const rows = db
      .prepare(
        `SELECT * FROM events WHERE ${where} AND id<? ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, before, limit + 1);
    const more = rows.length > limit;
    const events = rows.slice(0, limit).map(eventValue);
    const stats = db
      .prepare(
        `SELECT username, count(*) operations,
      sum(action='approved') approved, sum(action='rejected') rejected,
      sum(action='seek') seeks, sum(action='label_add') labelsAdded, sum(action='label_delete') labelsDeleted,
      avg(CASE WHEN action IN ('approved','rejected') THEN elapsed_ms END) averageMs,
      max(occurred_ms) lastActivityAtMs, max(CASE WHEN action IN ('heartbeat','loaded','focus') AND received_ms-occurred_ms<30000 THEN received_ms END) presenceAtMs
      FROM events WHERE ${where} AND action NOT IN ('heartbeat','focus','blur') GROUP BY username`,
      )
      .all(...args);
    const presence = new Map(
      db
        .prepare(
          `SELECT username,max(received_ms) presence FROM events WHERE action IN ('heartbeat','loaded','focus') AND received_ms-occurred_ms<30000 GROUP BY username`,
        )
        .all()
        .map((row) => [row.username, row.presence]),
    );
    const users = accounts
      .filter((user) => user.role === "operator")
      .map((user) => ({
        username: user.username,
        displayName: user.displayName,
        accountStatus: user.accountStatus ?? "active",
        operations: 0,
        approved: 0,
        rejected: 0,
        seeks: 0,
        labelsAdded: 0,
        labelsDeleted: 0,
        averageMs: null,
        lastActivityAtMs: null,
        ...stats.find((row) => row.username === user.username),
        online: Date.now() - (presence.get(user.username) ?? 0) < 45_000,
      }));
    const sessionBefore =
      Number(input.sessionBefore) || Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(sessionBefore) || sessionBefore < 1)
      throw new Error("REVIEW_QUERY_INVALID: 分页无效");
    const sessionRows = db
      .prepare(
        `SELECT username,session_id sessionId,episode_key episodeKey,episode_name episodeName,max(id) cursor,
      min(occurred_ms-elapsed_ms) loadedAtMs,max(occurred_ms) lastActivityAtMs,sum(action NOT IN ('heartbeat','focus','blur')) operations,
      max(CASE WHEN action IN ('approved','rejected') THEN elapsed_ms END) durationMs
      FROM events WHERE ${where} GROUP BY username,session_id HAVING max(id)<? ORDER BY cursor DESC LIMIT ?`,
      )
      .all(...args, sessionBefore, limit + 1);
    const sessions = sessionRows.slice(0, limit).map((row) => {
      const decision = db
        .prepare(
          `SELECT action,elapsed_ms FROM events WHERE username=? AND session_id=? AND action IN ('approved','rejected','saved') ORDER BY elapsed_ms DESC,id DESC LIMIT 1`,
        )
        .get(row.username, row.sessionId);
      return {
        ...row,
        status:
          decision?.action === "saved"
            ? "pending"
            : (decision?.action ?? "pending"),
        durationMs:
          decision && decision.action !== "saved" ? decision.elapsed_ms : null,
      };
    });
    return {
      events,
      users,
      sessions,
      nextSessionBefore:
        sessionRows.length > limit ? sessions.at(-1).cursor : null,
      nextBefore: more ? events.at(-1).id : null,
      total: db
        .prepare(`SELECT count(*) total FROM events WHERE ${where}`)
        .get(...args).total,
      generatedAtMs: Date.now(),
    };
  }
  return { append, query, close: () => db.close() };
}
function eventValue(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    username: row.username,
    displayName: row.display_name,
    sessionId: row.session_id,
    episodeKey: row.episode_key,
    episodeName: row.episode_name,
    action: row.action,
    occurredAtMs: row.occurred_ms,
    receivedAtMs: row.received_ms,
    elapsedMs: row.elapsed_ms,
    details: JSON.parse(row.details),
  };
}
