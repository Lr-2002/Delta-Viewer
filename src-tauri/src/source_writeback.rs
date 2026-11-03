//! Admin-authorized device-local writeback. Durable snapshots exclude drafts/cloud/local disks.
use crate::{
    error::{AppError, AppResult},
    identity::AuthState,
    model::UserIdentity,
    source_review_queue as queue,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Overview,
    Push {
        all: bool,
        usernames: Vec<String>,
    },
    Poll {
        #[serde(rename = "clientId")]
        client_id: String,
        busy: bool,
    },
    Step {
        #[serde(rename = "clientId")]
        client_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
    },
}
fn fail(e: impl std::fmt::Display) -> AppError {
    AppError::Message(format!(
        "WRITEBACK_LOCAL_STORAGE: {e}。本机待写结果仍保留，请重试"
    ))
}
fn open(root: &Path) -> AppResult<rusqlite::Connection> {
    let db = queue::open(root)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS writeback_jobs(service TEXT NOT NULL,username TEXT NOT NULL,client_id TEXT NOT NULL,request_id TEXT NOT NULL,finished INTEGER NOT NULL DEFAULT 0,seq INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(service,username,client_id,request_id));
        CREATE TABLE IF NOT EXISTS writeback_items(service TEXT NOT NULL,username TEXT NOT NULL,client_id TEXT NOT NULL,request_id TEXT NOT NULL,source_path TEXT NOT NULL,source_name TEXT NOT NULL,event_id TEXT NOT NULL,state TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(service,username,client_id,request_id,source_path,source_name));").map_err(fail)?;
    Ok(db)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub pending: usize,
    pub skipped: usize,
}
fn eligible(root: &Path, path: &str, network: &impl Fn(&Path) -> bool) -> bool {
    let path = Path::new(path);
    !path.starts_with(root.join("cloud-qc")) && network(path)
}
fn keys(root: &Path, service: &str, username: &str) -> AppResult<Vec<(String, String, String)>> {
    let db = queue::open(root)?;
    let mut q=db.prepare("SELECT source_path,source_name,event_id FROM source_reviews WHERE service=? AND username=? AND (source_name='skeleton.description.json' OR coalesce(json_extract(payload,'$.request.status'),'pending')!='pending') ORDER BY rowid").map_err(fail)?;
    let rows = q
        .query_map(params![service, username], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(fail)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(fail)
}
pub fn summary(root: &Path, service: &str, username: &str) -> AppResult<Summary> {
    let rows = keys(root, service, username)?;
    let network = crate::storage::network_source_filter();
    let pending = rows
        .iter()
        .filter(|(p, _, _)| eligible(root, p, &network))
        .count();
    Ok(Summary {
        pending,
        skipped: rows.len() - pending,
    })
}
fn begin(root: &Path, service: &str, user: &str, client: &str, id: &str) -> AppResult<()> {
    let mut db = open(root)?;
    if db.query_row("SELECT 1 FROM writeback_jobs WHERE service=? AND username=? AND client_id=? AND request_id=?",params![service,user,client,id],|_|Ok(())).optional().map_err(fail)?.is_some(){return Ok(());}
    let rows = keys(root, service, user)?;
    let network = crate::storage::network_source_filter();
    let tx = db.transaction().map_err(fail)?;
    tx.execute(
        "INSERT INTO writeback_jobs VALUES(?,?,?,?,0,1)",
        params![service, user, client, id],
    )
    .map_err(fail)?;
    for (p, s, event) in rows {
        if eligible(root, &p, &network) {
            tx.execute(
                "INSERT INTO writeback_items VALUES(?,?,?,?,?,?,?,'waiting','')",
                params![service, user, client, id, p, s, event],
            )
            .map_err(fail)?;
        }
    }
    tx.commit().map_err(fail)?;
    Ok(())
}
pub fn report(root: &Path, service: &str, user: &str, client: &str) -> AppResult<Option<Value>> {
    let db = open(root)?;
    let job:Option<(String,bool,i64)>=db.query_row("SELECT request_id,finished,seq FROM writeback_jobs WHERE service=? AND username=? AND client_id=? ORDER BY rowid DESC LIMIT 1",params![service,user,client],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
    let Some((id, finished, seq)) = job else {
        return Ok(None);
    };
    let (total,written):(i64,i64)=db.query_row("SELECT count(*),coalesce(sum(state='written'),0) FROM writeback_items WHERE service=? AND username=? AND client_id=? AND request_id=?",params![service,user,client,id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(fail)?;
    let mut q=db.prepare("SELECT DISTINCT error FROM writeback_items WHERE service=? AND username=? AND client_id=? AND request_id=? AND error!=''").map_err(fail)?;
    let errors = q
        .query_map(params![service, user, client, id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(fail)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(fail)?;
    let state = if !finished {
        "running"
    } else if written == total {
        "complete"
    } else {
        "partial"
    };
    Ok(Some(
        json!({"requestId":id,"seq":seq,"state":state,"total":total,"written":written,"remaining":total-written,"errors":errors}),
    ))
}
pub fn error_code(message: &str) -> &'static str {
    if message.contains("REVIEW_STORAGE_FULL") {
        "storage_full"
    } else if message.contains("CONFLICT")
        || message.contains("已有审核结论")
        || message.contains("已改变")
    {
        "conflict"
    } else if message.contains("OVERLAP") || message.contains("片段") {
        "invalid_result"
    } else if message.contains("LOCAL_STORAGE") || message.contains("OUTBOX_STORAGE") {
        "local_storage"
    } else if message.contains("REVIEW_STORAGE_")
        || message.contains("SOURCE_UNAVAILABLE")
        || message.contains("I/O")
        || message.contains("路径")
    {
        "storage_unavailable"
    } else {
        "unknown"
    }
}
/// One item per step. Release the global operation guard between steps so normal work can proceed.
pub fn step(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    client: &str,
    id: &str,
    auth: &AuthState,
) -> AppResult<Value> {
    step_with(
        root,
        service,
        user,
        client,
        id,
        &|| crate::user_center::check_review_owner(root, auth, &user.username, service),
        &crate::source_path_probe::ensure_review_storage_responsive,
    )
}
fn step_with(
    root: &Path,
    service: &str,
    user: &UserIdentity,
    client: &str,
    id: &str,
    check_owner: &impl Fn() -> AppResult<()>,
    probe: &impl Fn(&Path) -> AppResult<()>,
) -> AppResult<Value> {
    let _lock = queue::owner_lock(root, service, &user.username)?;
    check_owner()?;
    begin(root, service, &user.username, client, id)?;
    let db = open(root)?;
    let item:Option<(String,String,String)>=db.query_row("SELECT source_path,source_name,event_id FROM writeback_items WHERE service=? AND username=? AND client_id=? AND request_id=? AND state='waiting' ORDER BY rowid LIMIT 1",params![service,user.username,client,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(fail)?;
    if let Some((path, source, event)) = item {
        let entry = queue::get(root, service, &user.username, &path, Some(&source));
        let code = match entry {
            Err(error) => Some(error_code(&error.to_string())),
            Ok(None) => {
                // It may already have been written manually, but absence alone is not evidence.
                let confirmed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM source_review_receipts WHERE service=? AND username=? AND event_id=?)",params![service,user.username,nas_receipt_id(&event)],|r|r.get(0)).map_err(fail)?;
                if confirmed {
                    None
                } else {
                    Some("changed")
                }
            }
            Ok(Some(entry))
                if entry.audit["eventId"].as_str() != Some(event.as_str())
                    || entry.is_action_draft() =>
            {
                Some("changed")
            }
            Ok(Some(mut entry)) => {
                check_owner()?;
                match queue::publish_entry(root, service, user, &entry, probe) {
                    Ok(_) => None,
                    Err(error) => {
                        entry.error = error.to_string();
                        open(root)?.execute("UPDATE source_reviews SET payload=? WHERE service=? AND username=? AND source_path=? AND source_name=? AND event_id=?",params![serde_json::to_string(&entry)?,service,user.username,path,source,event]).map_err(fail)?;
                        Some(error_code(&entry.error))
                    }
                }
            }
        };
        let mut db = open(root)?;
        let tx = db.transaction().map_err(fail)?;
        tx.execute("UPDATE writeback_items SET state=?,error=? WHERE service=? AND username=? AND client_id=? AND request_id=? AND source_path=? AND source_name=?",params![if code.is_none(){"written"}else{"failed"},code.unwrap_or(""),service,user.username,client,id,path,source]).map_err(fail)?;
        if matches!(
            code,
            Some("storage_full" | "storage_unavailable" | "local_storage")
        ) {
            tx.execute("UPDATE writeback_items SET state='failed',error=? WHERE service=? AND username=? AND client_id=? AND request_id=? AND state='waiting'",params![code.unwrap(),service,user.username,client,id]).map_err(fail)?;
        }
        tx.execute("UPDATE writeback_jobs SET seq=seq+1 WHERE service=? AND username=? AND client_id=? AND request_id=?",params![service,user.username,client,id]).map_err(fail)?;
        tx.commit().map_err(fail)?;
    }
    db.execute("UPDATE writeback_jobs SET finished=1,seq=seq+1 WHERE service=? AND username=? AND client_id=? AND request_id=? AND finished=0 AND NOT EXISTS(SELECT 1 FROM writeback_items WHERE service=? AND username=? AND client_id=? AND request_id=? AND state='waiting')",params![service,user.username,client,id,service,user.username,client,id]).map_err(fail)?;
    report(root, service, &user.username, client)?.ok_or_else(|| fail("写回记录缺失"))
}
fn nas_receipt_id(event: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(format!("nas:{event}").as_bytes()));
    format!(
        "{}-{}-4{}-8{}-{}",
        &digest[..8],
        &digest[8..12],
        &digest[13..16],
        &digest[17..20],
        &digest[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: std::path::PathBuf,
        source: std::path::PathBuf,
        user: UserIdentity,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "delta-writeback-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let source = root.join("sample");
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("bailian_annotation.json"),serde_json::to_vec(&json!({"schema_version":3,"episode_results":[{"episode_id":"sample","media":{"frame_count":20,"frame_index_base":0,"interval_convention":"[start,end)"},"annotations":[{"id":"a","segment_id":"s","label_code":"walk","start_frame":0,"end_frame":20,"attributes":{"semantic_description":"走路"}}],"segments":[{"segment_id":"s","annotation_id":"a","start_frame":0,"end_frame":20}]}]})).unwrap()).unwrap();
            let user = UserIdentity {
                username: "alice".into(),
                display_name: "原审核人".into(),
                role: Some("operator".into()),
                can_manage: false,
            };
            Self { root, source, user }
        }
        fn entry(&self, status: &str, id: &str) -> queue::DeferredReview {
            let state = crate::machine_review::load(&self.root, &self.source).unwrap();
            queue::DeferredReview {
                request: crate::machine_review::SaveReviewRequest {
                    special_tags: None,
                    source_path: self.source.to_string_lossy().into(),
                    source_name: Some(crate::machine_annotation::DEFAULT_SOURCE.into()),
                    source_hash: state.source_hash,
                    expected_revision: state.revision,
                    segments: state.segments,
                    status: Some(status.into()),
                    rejection_reason: Some("动作失范".into()),
                },
                output_hash: None,
                qc_content_hash: None,
                only_pending: false,
                audit: json!({"eventId":id,"action":if status=="approved"{"approved"}else{"rejected"},"occurredAtMs":1792548000000u64,"details":{}}),
                error: "REVIEW_STORAGE_FULL".into(),
                created_at_ms: 1234,
            }
        }
        fn queue(&self, entry: queue::DeferredReview) {
            queue::store(&self.root, "s", &self.user.username, entry).unwrap();
        }
        fn snapshot(&self, id: &str) {
            let db = open(&self.root).unwrap();
            db.execute(
                "INSERT INTO writeback_jobs VALUES('s','alice','client',?,0,1)",
                params![id],
            )
            .unwrap();
            for (p, s, event) in keys(&self.root, "s", "alice").unwrap() {
                db.execute(
                    "INSERT INTO writeback_items VALUES('s','alice','client',?,?,?,?,'waiting','')",
                    params![id, p, s, event],
                )
                .unwrap();
            }
        }
        fn run(&self, id: &str, probe: impl Fn(&Path) -> AppResult<()>) -> Value {
            step_with(
                &self.root,
                "s",
                &self.user,
                "client",
                id,
                &|| Ok(()),
                &probe,
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn remote_job_restarts_after_source_commit_without_losing_provenance_or_republishing() {
        let f = Fixture::new();
        let entry = f.entry("approved", "11111111-1111-4111-8111-111111111111");
        f.queue(entry.clone());
        f.snapshot("job");
        // Crash between the existing publisher's durable source receipt and remote job bookkeeping.
        queue::publish_entry(&f.root, "s", &f.user, &entry, &|_| Ok(())).unwrap();
        assert_eq!(
            report(&f.root, "s", "alice", "client").unwrap().unwrap()["written"],
            0
        );
        let before = std::fs::read(f.source.join("description.json")).unwrap();
        let result = f.run("job", |_| panic!("already written, must not touch NAS"));
        assert_eq!(result["state"], "complete");
        assert_eq!(result["written"], 1);
        assert_eq!(
            std::fs::read(f.source.join("description.json")).unwrap(),
            before
        );
        let saved = crate::machine_review::load(&f.root, &f.source).unwrap();
        assert_eq!(saved.status, "approved");
        let output: Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(output["_human_review"].as_object().unwrap().len(), 3);
        assert!(before
            .windows("原审核人".len())
            .any(|b| b == "原审核人".as_bytes()));
        assert!(report(&f.root, "s", "bob", "client").unwrap().is_none());
        assert!(report(&f.root, "other", "alice", "client")
            .unwrap()
            .is_none());
    }
    #[test]
    fn full_disk_conflict_and_reopened_result_remain_local_and_need_new_command() {
        for message in [
            "REVIEW_STORAGE_FULL",
            "REVIEW_STORAGE_UNRESPONSIVE",
            "SOURCE_REVIEW_CONFLICT",
            "MACHINE_REVIEW_OVERLAP",
        ] {
            let f = Fixture::new();
            let entry = f.entry("rejected", "22222222-2222-4222-8222-222222222222");
            f.queue(entry.clone());
            f.snapshot("job");
            let result = f.run("job", |_| Err(AppError::Message(message.into())));
            assert_eq!(result["state"], "partial");
            assert_eq!(result["remaining"], 1);
            assert_eq!(result["errors"][0], error_code(message));
            let retained = queue::get(
                &f.root,
                "s",
                "alice",
                f.source.to_str().unwrap(),
                entry.request.source_name.as_deref(),
            )
            .unwrap()
            .unwrap();
            assert_eq!(retained.audit, entry.audit);
            assert!(!f.source.join("description.json").exists());
            assert_eq!(
                f.run("job", |_| panic!("terminal job cannot restart"))["state"],
                "partial"
            );
            f.snapshot("retry");
            assert_eq!(f.run("retry", |_| Ok(()))["state"], "complete");
        }
        let f = Fixture::new();
        let entry = f.entry("approved", "33333333-3333-4333-8333-333333333333");
        f.queue(entry.clone());
        f.snapshot("job");
        let mut draft = entry;
        draft.request.status = Some("pending".into());
        draft.audit["action"] = json!("saved");
        draft.audit["eventId"] = json!("44444444-4444-4444-8444-444444444444");
        f.queue(draft);
        assert_eq!(
            f.run("job", |_| panic!("must not publish new draft"))["errors"][0],
            "changed"
        );
        assert!(queue::get(
            &f.root,
            "s",
            "alice",
            f.source.to_str().unwrap(),
            Some(crate::machine_annotation::DEFAULT_SOURCE)
        )
        .unwrap()
        .unwrap()
        .is_action_draft());
    }
    #[test]
    fn source_selection_excludes_drafts_local_disks_and_other_accounts_and_authorization_is_rechecked(
    ) {
        let f = Fixture::new();
        let mut entry = f.entry("pending", "55555555-5555-4555-8555-555555555555");
        entry.audit["action"] = json!("saved");
        f.queue(entry);
        assert!(keys(&f.root, "s", "alice").unwrap().is_empty());
        f.queue(f.entry("approved", "66666666-6666-4666-8666-666666666666"));
        assert_eq!(keys(&f.root, "s", "alice").unwrap().len(), 1);
        assert!(keys(&f.root, "s", "bob").unwrap().is_empty());
        let status = summary(&f.root, "s", "alice").unwrap();
        assert_eq!(status.pending, 0);
        assert_eq!(status.skipped, 1);
        assert!(!eligible(
            &f.root,
            f.root.join("cloud-qc/data/test").to_str().unwrap(),
            &|_| true
        ));
        assert!(step_with(
            &f.root,
            "s",
            &f.user,
            "client",
            "id",
            &|| Err(AppError::Message("AUTH_REQUIRED".into())),
            &|_| panic!("must not write")
        )
        .is_err());
        assert!(report(&f.root, "s", "alice", "client").unwrap().is_none());
    }
}
