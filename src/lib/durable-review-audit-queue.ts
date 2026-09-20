import type { ReviewAuditEvent } from "./review-audit-types";

export interface ReviewOutboxStatus { pending: number; blocked: number; error: string }
export interface ReviewOutboxBackend {
  persist(events: ReviewAuditEvent[]): Promise<ReviewOutboxStatus>;
  flush(retryBlocked: boolean): Promise<ReviewOutboxStatus>;
}

function checkedStatus(value: ReviewOutboxStatus): ReviewOutboxStatus {
  if (!value || !Number.isSafeInteger(value.pending) || value.pending < 0
    || !Number.isSafeInteger(value.blocked) || value.blocked < 0 || value.blocked > value.pending
    || typeof value.error !== "string") throw Error("监管记录保存状态无效，记录已保留待重试");
  return value;
}

export function durableReviewAuditQueue(storage: Storage, owner: string, backend: ReviewOutboxBackend, notify: (message: string) => void) {
  const prefix = `dohc.review-audit.v1:${encodeURIComponent(owner)}:`;
  const memory = new Map<string, ReviewAuditEvent>();
  let writing: Promise<void> | null = null;
  let flushing: Promise<number> | null = null;
  let status: ReviewOutboxStatus = { pending: 0, blocked: 0, error: "" };
  let diskError = "", migrationError = "";
  let migrated = false;
  let unmigrated = 0;
  let lastReport = "";
  function report() {
    const message = [
      memory.size && diskError ? `监管记录 ${memory.size} 条仅保存在内存，关闭前需恢复保存` : "",
      status.pending && (status.pending > 20 || status.error || diskError || migrationError) ? `监管记录 ${status.pending} 条已保存在本机，待上传${status.blocked ? `（${status.blocked} 条异常已单独保留）` : ""}` : "",
      diskError, migrationError, status.error,
    ].filter(Boolean).join("；");
    if (message !== lastReport) { lastReport = message; notify(message); }
  }
  async function migrate() {
    if (migrated) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    let invalid = 0;
    for (let offset = 0; offset < keys.length; offset += 20) {
      const batch: { key: string; raw: string; event: ReviewAuditEvent }[] = [];
      for (const key of keys.slice(offset, offset + 20)) {
        const raw = storage.getItem(key);
        if (!raw) continue;
        try {
          const event = JSON.parse(raw) as ReviewAuditEvent;
          if (!event || typeof event.eventId !== "string" || key !== prefix + event.eventId) throw Error("invalid event");
          batch.push({ key, raw, event });
        } catch { invalid++; }
      }
      if (!batch.length) continue;
      const saved = checkedStatus(await backend.persist(batch.map((row) => row.event)));
      status = { ...saved, error: status.error || saved.error };
      // Delete old storage ONLY after the native database transaction has committed.
      for (const row of batch) if (storage.getItem(row.key) === row.raw) storage.removeItem(row.key);
    }
    migrationError = invalid ? `${invalid} 条旧监管缓存无法解析，已原样保留` : "";
    unmigrated = invalid;
    migrated = invalid === 0;
  }
  function persist(): Promise<void> {
    if (writing) return writing;
    writing = (async () => {
      try {
        while (memory.size) {
          const batch = [...memory.values()].slice(0, 20);
          const saved = checkedStatus(await backend.persist(batch));
          status = { ...saved, error: status.error || saved.error };
          for (const event of batch) if (memory.get(event.eventId) === event) memory.delete(event.eventId);
        }
        diskError = "";
        await migrate();
      } catch (error) { diskError = String(error); }
      finally { writing = null; report(); }
    })();
    return writing;
  }
  return {
    push(event: ReviewAuditEvent) {
      memory.set(event.eventId, event);
      void persist();
    },
    volatileCount: () => memory.size,
    async persist() { await persist(); if (memory.size) throw Error(diskError || "监管记录尚未落盘"); },
    flush(retryBlocked = false): Promise<number> {
      if (flushing) return flushing;
      flushing = (async () => {
        await persist();
        try { status = checkedStatus(await backend.flush(retryBlocked)); }
        catch (error) { status.error = String(error); }
        report();
        return status.pending + memory.size + unmigrated;
      })().finally(() => { flushing = null; });
      return flushing;
    },
  };
}
