// Commands/receipts only. Full review JSON and filesystem paths stay on the originating device.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
export const SOURCE_WRITEBACK_CAPABILITY = 'sourceWritebackV1';
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
const fields = (value, allowed) => value && Object.keys(value).every(key=>allowed.includes(key));
const codes = new Set(['storage_full','storage_unavailable','source_missing','storage_timeout','conflict','invalid_result','changed','local_storage','unknown']);
export function openSourceWriteback(dataRoot, clock = Date.now) {
  const file=path.join(dataRoot,'source-writeback.sqlite'), db=new DatabaseSync(file);
  chmodSync(file,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS requests(username TEXT PRIMARY KEY,id TEXT NOT NULL,sender TEXT NOT NULL,created_ms INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices(username TEXT NOT NULL,client_id TEXT NOT NULL,seen_ms INTEGER NOT NULL,version TEXT NOT NULL,pending INTEGER NOT NULL,skipped INTEGER NOT NULL,issue TEXT NOT NULL,PRIMARY KEY(username,client_id));
    CREATE TABLE IF NOT EXISTS deliveries(request_id TEXT NOT NULL,username TEXT NOT NULL,client_id TEXT NOT NULL,state TEXT NOT NULL,report TEXT,seq INTEGER NOT NULL DEFAULT 0,updated_ms INTEGER NOT NULL,PRIMARY KEY(request_id,username,client_id));
    CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,username TEXT NOT NULL,sender TEXT NOT NULL,created_ms INTEGER NOT NULL);`);
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}}
  function delivery(id,username,clientId){return db.prepare('SELECT * FROM deliveries WHERE request_id=? AND username=? AND client_id=?').get(id,username,clientId);}
  function attach(id,username,clientId){db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,'waiting',NULL,0,?)").run(id,username,clientId,clock());}
  function current(username){return db.prepare('SELECT id,sender,created_ms AS createdAtMs FROM requests WHERE username=?').get(username)??null;}
  function validate(input){
    if(!fields(input,['clientId','version','pending','skipped','availability','report','localIssue']) || !validId(input.clientId) || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(input.version??'') || !integer(input.pending) || !integer(input.skipped) || !['idle','busy'].includes(input.availability) || (input.localIssue!==undefined && !['local_storage','unknown'].includes(input.localIssue)))throw Error('WRITEBACK_REPORT_INVALID');
    const r=input.report;
    if(r && (!fields(r,['requestId','seq','state','total','written','remaining','attempted','failed','unattempted','errors']) || !validId(r.requestId) || !integer(r.seq) || !['running','complete','partial'].includes(r.state) || !integer(r.total) || !integer(r.written) || !integer(r.remaining) || r.written+r.remaining!==r.total || !Array.isArray(r.errors) || r.errors.length>codes.size || r.errors.some(c=>!codes.has(c)) || new Set(r.errors).size!==r.errors.length || (r.state==='complete' && (r.remaining!==0 || r.errors.length)) || (r.state==='partial' && (!r.remaining || !r.errors.length))))throw Error('WRITEBACK_REPORT_INVALID');
    if(r && ['attempted','failed','unattempted'].some(key=>r[key]!==undefined) &&
      (!integer(r.attempted)||!integer(r.failed)||!integer(r.unattempted)||r.attempted!==r.written+r.failed||r.total!==r.attempted+r.unattempted||r.failed+r.unattempted!==r.remaining||(r.failed>0&&!r.errors.length)))throw Error('WRITEBACK_REPORT_INVALID');
  }
  return {
    push(sender,usernames,knownDevices=[]){return tx(()=>({queued:usernames.map(username=>{
      let request=current(username);
      // Dedupe while at least one known device has not finished, or no device has reported yet.
      const unfinished=request && db.prepare("SELECT count(*) AS n FROM deliveries WHERE request_id=? AND state NOT IN ('complete','partial')").get(request.id).n;
      const count=request && db.prepare('SELECT count(*) AS n FROM deliveries WHERE request_id=?').get(request.id).n;
      const failed=request && db.prepare("SELECT count(*) AS n FROM deliveries WHERE request_id=? AND state='partial'").get(request.id).n;
      const newlyPending=request && db.prepare("SELECT count(*) AS n FROM deliveries d JOIN devices c ON c.username=d.username AND c.client_id=d.client_id WHERE d.request_id=? AND d.state='complete' AND c.pending>0").get(request.id).n;
      const reused=Boolean(request && !failed && !newlyPending && (unfinished || !count));
      if(!reused){request={id:randomUUID(),sender,createdAtMs:clock()};db.prepare('INSERT OR REPLACE INTO requests VALUES(?,?,?,?)').run(username,request.id,sender,request.createdAtMs);db.prepare('INSERT INTO history VALUES(?,?,?,?)').run(request.id,username,sender,request.createdAtMs);}
      const ids=new Set([...knownDevices.filter(d=>d.username===username).map(d=>d.clientId),...db.prepare('SELECT client_id FROM devices WHERE username=?').all(username).map(d=>d.client_id)]);
      for(const id of ids)attach(request.id,username,id);
      return {username,id:request.id,reused};
    })}));},
    poll(username,input){validate(input);return tx(()=>{
      const now=clock();
      db.prepare('INSERT OR REPLACE INTO devices VALUES(?,?,?,?,?,?,?)').run(username,input.clientId,now,input.version,input.pending,input.skipped,input.localIssue??'');
      const request=current(username);
      if(!request)return {request:null,receipt:null,generatedAtMs:now};
      attach(request.id,username,input.clientId);
      const r=input.report,old=delivery(request.id,username,input.clientId);
      if(r?.requestId===request.id && r.seq>old.seq){
        // Terminal receipts cannot be overwritten by a stale/unrelated successful heartbeat.
        if(!['complete','partial'].includes(old.state))db.prepare('UPDATE deliveries SET state=?,report=?,seq=?,updated_ms=? WHERE request_id=? AND username=? AND client_id=?').run(r.state,JSON.stringify(r),r.seq,now,request.id,username,input.clientId);
      }
      const next=delivery(request.id,username,input.clientId);
      if(!['complete','partial'].includes(next.state) && (input.localIssue || next.state!=='running'))db.prepare('UPDATE deliveries SET state=?,updated_ms=? WHERE request_id=? AND username=? AND client_id=?').run(input.localIssue?'error':input.availability==='busy'?'busy':'waiting',now,request.id,username,input.clientId);
      // A successful unrelated poll is not an acknowledgement of a local result.
      const receipt=r?.requestId===request.id && next.report && next.seq>=r.seq ? JSON.parse(next.report) : null;
      return {request:['complete','partial'].includes(next.state)?null:request,receipt,generatedAtMs:now};
    });},
    authorizeStep(username,clientId,requestId){
      if(!validId(clientId)||!validId(requestId))throw Error('WRITEBACK_REQUEST_INVALID');
      const request=current(username),row=delivery(requestId,username,clientId);
      if(request?.id!==requestId || !row || ['complete','partial'].includes(row.state))throw Error('WRITEBACK_REQUEST_STALE');
      const device=db.prepare('SELECT issue FROM devices WHERE username=? AND client_id=?').get(username,clientId);
      if(device?.issue)throw Error('WRITEBACK_LOCAL_STORAGE: 原电脑队列尚不可读取');
      db.prepare("UPDATE deliveries SET state='running',updated_ms=? WHERE request_id=? AND username=? AND client_id=?").run(clock(),requestId,username,clientId);
      return {allowed:true};
    },
    overview(users,presence){const now=clock();return {generatedAtMs:now,users:users.map(user=>{
      const request=current(user.username);
      const devices=db.prepare('SELECT client_id AS clientId,seen_ms AS lastSeenAtMs,version,pending,skipped,issue FROM devices WHERE username=? ORDER BY seen_ms DESC').all(user.username)
        .map(device=>({...device,...(presence?{online:presence.users.find(u=>u.username===user.username)?.clients.some(c=>c.clientId===device.clientId&&c.online)??false}:{})}));
      const deliveries=request?db.prepare('SELECT client_id AS clientId,state,report,updated_ms AS updatedAtMs FROM deliveries WHERE request_id=? AND username=?').all(request.id,user.username).map(d=>({...d,report:d.report?JSON.parse(d.report):null})):[];
      return {username:user.username,request,devices,deliveries};
    })};},
    close(){db.close();},
  };
}
