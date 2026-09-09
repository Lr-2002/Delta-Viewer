import type { AnnotationAuditRequest } from "../types";

export function createAuditFlusher(
  read: () => AnnotationAuditRequest[],
  write: (queue: AnnotationAuditRequest[]) => void,
  send: (request: AnnotationAuditRequest) => Promise<void>,
) {
  let active: Promise<number> | null = null;
  return function flush(): Promise<number> {
    if (active) return active;
    active = (async () => {
      for (const request of read()) {
        await send(request);
        // Remove only the acknowledged event from the current queue; another
        // operation may have queued an event while the request was in flight.
        write(read().filter((item) => item.eventId !== request.eventId));
      }
      return read().length;
    })().finally(() => { active = null; });
    return active;
  };
}
