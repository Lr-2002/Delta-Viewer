import type { ReviewAuditEvent } from "./review-audit-types";

// Each event has its own durable key; acknowledgements never overwrite newer events.
export function reviewAuditQueue(
  storage: Storage,
  owner: string,
  send: (events: ReviewAuditEvent[]) => Promise<{ eventIds: string[] }>,
) {
  const prefix = `dohc.review-audit.v1:${encodeURIComponent(owner)}:`;
  let active: Promise<number> | null = null;
  const pending = new Map<string, ReviewAuditEvent>();
  function read() {
    const rows = new Map(pending);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) {
        const event = JSON.parse(storage.getItem(key)!) as ReviewAuditEvent;
        rows.set(event.eventId, event);
      }
    }
    return [...rows.values()].sort(
      (a, b) => a.occurredAtMs - b.occurredAtMs || a.elapsedMs - b.elapsedMs,
    );
  }
  return {
    push(event: ReviewAuditEvent) {
      // Retain the event in memory even if the disk quota is exhausted.
      pending.set(event.eventId, event);
      storage.setItem(prefix + event.eventId, JSON.stringify(event));
      pending.delete(event.eventId);
    },
    volatileCount: () => pending.size,
    count: () => read().length,
    flush() {
      if (active) return active;
      active = (async () => {
        const events = read();
        for (let offset = 0; offset < events.length; offset += 8) {
          const batch = events.slice(offset, offset + 8);
          const result = await send(batch);
          for (const event of batch) {
            if (!result.eventIds.includes(event.eventId))
              throw new Error("审核事件尚未被服务确认");
            storage.removeItem(prefix + event.eventId);
            pending.delete(event.eventId);
          }
        }
        return read().length;
      })().finally(() => {
        active = null;
      });
      return active;
    },
  };
}
