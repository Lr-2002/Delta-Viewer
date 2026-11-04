// Rebuildable derivatives only. Source audit events/identities are never changed.
// A worker advances this cursor in bounded transactions, then serves an exact
// all-history summary without scanning millions of raw events on every poll.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, statSync } from "node:fs";
import path from "node:path";

export function openReviewSummary(dataRoot, source) {
  const file = path.join(dataRoot, "review-summary-v1.sqlite"), db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
    CREATE TABLE IF NOT EXISTS source_identity(identity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,total INTEGER NOT NULL);
    INSERT OR IGNORE INTO meta VALUES(1,0,0);
    CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY,operations INTEGER,approved INTEGER,rejected INTEGER,seeks INTEGER,added INTEGER,deleted INTEGER,decision_sum INTEGER,decisions INTEGER,last_ms INTEGER,presence_ms INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(username TEXT,session TEXT,episode_key TEXT,episode_name TEXT,cursor INTEGER,loaded_ms INTEGER,last_ms INTEGER,operations INTEGER,decision_ms INTEGER,decision_id INTEGER,decision TEXT,duration INTEGER,PRIMARY KEY(username,session));
    CREATE INDEX IF NOT EXISTS sessions_cursor ON sessions(cursor DESC);
    CREATE TABLE IF NOT EXISTS completions(identity TEXT PRIMARY KEY,username TEXT,event_id TEXT,action TEXT,occurred_ms INTEGER,event_seq INTEGER,storage TEXT);
    CREATE TABLE IF NOT EXISTS receipts(username TEXT,event_id TEXT,PRIMARY KEY(username,event_id));`);
  const sourceStat=statSync(path.join(dataRoot,"review-audit.sqlite"));
  const identity=`${sourceStat.dev}:${sourceStat.ino}`, previous=db.prepare("SELECT identity FROM source_identity").get();
  if(previous && previous.identity!==identity){db.close();throw Error("REVIEW_SUMMARY_SOURCE_CHANGED: 审核源库已替换，请重建派生统计，不使用旧统计");}
  if(!previous)db.prepare("INSERT INTO source_identity VALUES(?)").run(identity);
  const userUpsert = db.prepare(`INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(username) DO UPDATE SET
    operations=operations+excluded.operations,approved=approved+excluded.approved,rejected=rejected+excluded.rejected,seeks=seeks+excluded.seeks,added=added+excluded.added,deleted=deleted+excluded.deleted,
    decision_sum=decision_sum+excluded.decision_sum,decisions=decisions+excluded.decisions,last_ms=max(last_ms,excluded.last_ms),presence_ms=max(presence_ms,excluded.presence_ms)`);
  const sessionUpsert = db.prepare(`INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(username,session) DO UPDATE SET
    episode_key=excluded.episode_key,episode_name=excluded.episode_name,cursor=excluded.cursor,
    loaded_ms=min(loaded_ms,excluded.loaded_ms),last_ms=max(last_ms,excluded.last_ms),operations=operations+excluded.operations,
    decision=CASE WHEN excluded.decision_ms>decision_ms OR (excluded.decision_ms=decision_ms AND excluded.decision_id>decision_id) THEN excluded.decision ELSE decision END,
    duration=CASE WHEN excluded.decision_ms>decision_ms OR (excluded.decision_ms=decision_ms AND excluded.decision_id>decision_id) THEN excluded.duration ELSE duration END,
    decision_id=CASE WHEN excluded.decision_ms>decision_ms OR (excluded.decision_ms=decision_ms AND excluded.decision_id>decision_id) THEN excluded.decision_id ELSE decision_id END,
    decision_ms=max(decision_ms,excluded.decision_ms)`);
  const completion = db.prepare(`INSERT INTO completions VALUES(?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET
    username=excluded.username,event_id=excluded.event_id,action=excluded.action,occurred_ms=excluded.occurred_ms,event_seq=excluded.event_seq,storage=excluded.storage
    WHERE excluded.occurred_ms>occurred_ms OR (excluded.occurred_ms=occurred_ms AND excluded.event_seq>event_seq)`);
  const receipt = db.prepare("INSERT OR IGNORE INTO receipts VALUES(?,?)");
  const batch = source.prepare(`SELECT id,username,session_id,episode_key,episode_name,action,occurred_ms,received_ms,elapsed_ms,
    CASE WHEN action IN ('saved','approved','rejected','source_written') THEN details ELSE NULL END details
    FROM events WHERE id>? AND id<=? ORDER BY id LIMIT 20000`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  function refresh() {
    const high = source.prepare("SELECT coalesce(max(id),0) high FROM events").get().high;
    let { cursor, total } = db.prepare("SELECT cursor,total FROM meta").get();
    if (cursor > high) throw Error("REVIEW_SUMMARY_SOURCE_CHANGED: 审核源库已变化，请重建派生统计");
    while (cursor < high) {
      const rows = batch.all(cursor, high);
      if (!rows.length) throw Error("REVIEW_SUMMARY_SOURCE_CHANGED: 审核统计游标不连续");
      const users = new Map(), sessions = new Map(), completions = [];
      for (const r of rows) {
        const operation = !["heartbeat", "focus", "blur", "source_written"].includes(r.action);
        const decision = ["approved", "rejected"].includes(r.action);
        const u = users.get(r.username) ?? [r.username,0,0,0,0,0,0,0,0,0,0];
        if (operation) {
          u[1]++; u[2] += r.action === "approved"; u[3] += r.action === "rejected";
          u[4] += r.action === "seek"; u[5] += r.action === "label_add"; u[6] += r.action === "label_delete";
          if (decision) { u[7] += r.elapsed_ms; u[8]++; }
          u[9] = Math.max(u[9], r.occurred_ms);
        }
        if (["heartbeat", "loaded", "focus"].includes(r.action) && r.received_ms-r.occurred_ms < 30000) u[10] = Math.max(u[10], r.received_ms);
        users.set(r.username,u);
        const key = r.username + ":" + r.session_id;
        const s = sessions.get(key) ?? [r.username,r.session_id,r.episode_key,r.episode_name,0,r.occurred_ms-r.elapsed_ms,0,0,-1,0,"pending",null];
        s[2]=r.episode_key; s[3]=r.episode_name; s[4]=r.id; s[5]=Math.min(s[5],r.occurred_ms-r.elapsed_ms); s[6]=Math.max(s[6],r.occurred_ms); s[7]+=operation;
        if ((decision || r.action === "saved") && (r.elapsed_ms>s[8] || (r.elapsed_ms===s[8] && r.id>s[9]))) {
          s[8]=r.elapsed_ms; s[9]=r.id; s[10]=r.action === "saved" ? "pending" : r.action; s[11]=decision ? r.elapsed_ms : null;
        }
        sessions.set(key,s);
        if (r.details) {
          try {
            const v = JSON.parse(JSON.parse(r.details).value);
            if (v.schema === "delta.review-receipt.v1" && ["local","nas"].includes(v.storage) && /^[a-f0-9]{64}$/.test(v.identityKey) && uuid.test(v.submissionId) && v.channel === "action"
              && (r.action === "source_written" || v.submissionId === eventId(r))) completions.push({r,v});
          } catch { /* Plain historical details remain ordinary operations. */ }
        }
      }
      // event_id is only needed for the small subset of receipt-bearing events.
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const u of users.values()) userUpsert.run(...u);
        for (const s of sessions.values()) sessionUpsert.run(...s);
        for (const {r,v} of completions) {
          if (r.action === "source_written") receipt.run(r.username,v.submissionId);
          else completion.run(v.identityKey,r.username,v.submissionId,r.action,r.occurred_ms,r.id,v.storage);
        }
        cursor = rows.at(-1).id; total += rows.length;
        db.prepare("UPDATE meta SET cursor=?,total=? WHERE id=1").run(cursor,total);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    return { cursor, total };
  }
  const eventIdQuery = source.prepare("SELECT event_id FROM events WHERE id=?");
  const eventId = row => eventIdQuery.get(row.id).event_id;
  return {
    query(input, accounts) {
      const throughAtMs = Date.now(), {cursor,total} = refresh(), limit=Math.min(200,Math.max(1,Number(input.limit)||100));
      const before=Number(input.sessionBefore)||Number.MAX_SAFE_INTEGER;
      const rows=db.prepare("SELECT username,session AS sessionId,episode_key AS episodeKey,episode_name AS episodeName,cursor,loaded_ms AS loadedAtMs,last_ms AS lastActivityAtMs,operations,decision AS status,duration AS durationMs FROM sessions WHERE cursor<? ORDER BY cursor DESC LIMIT ?").all(before,limit+1);
      const stats=db.prepare("SELECT * FROM users").all();
      const completed=db.prepare(`SELECT c.username,count(*) completed,sum(c.action='approved') completedApproved,sum(c.action='rejected') completedRejected,
        sum(c.storage='nas' OR r.event_id IS NOT NULL) nasConfirmed,sum(c.storage!='nas' AND r.event_id IS NULL) pendingNas
        FROM completions c LEFT JOIN receipts r ON r.username=c.username AND r.event_id=c.event_id WHERE c.action IN ('approved','rejected') GROUP BY c.username`).all();
      return { total, dataThroughEventId:cursor, dataThroughAtMs:throughAtMs,
        sessions:rows.slice(0,limit).map(row=>({...row})),nextSessionBefore:rows.length>limit?rows[limit-1].cursor:null,
        users:accounts.filter(u=>u.role==="operator").map(user=>{
          const s=stats.find(s=>s.username===user.username);
          return {username:user.username,displayName:user.displayName,accountStatus:user.accountStatus??"active",
            operations:s?.operations??0,approved:s?.approved??0,rejected:s?.rejected??0,seeks:s?.seeks??0,labelsAdded:s?.added??0,labelsDeleted:s?.deleted??0,
            averageMs:s?.decisions?s.decision_sum/s.decisions:null,lastActivityAtMs:s?.last_ms||null,
            online:(user.accountStatus??"active")==="active" && Date.now()-(s?.presence_ms??0)<45000,
            completed:0,completedApproved:0,completedRejected:0,pendingNas:0,nasConfirmed:0,...completed.find(c=>c.username===user.username)};
        }) };
    },
    close(){db.close();},
  };
}
