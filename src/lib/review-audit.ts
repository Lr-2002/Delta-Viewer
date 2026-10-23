import { flushReviewAuditQueue, getReviewAuditQueueStatus, isTauriRuntime, persistReviewAudit, sendReviewAudit } from "./backend";
import { reviewAuditQueue } from "./review-audit-queue";
import { durableReviewAuditQueue } from "./durable-review-audit-queue";
import type { ReviewAction, ReviewDetails, ReviewAuditEvent } from "./review-audit-types";

import type { ReviewSyncStatus } from "./review-audit-status";

let activeOwner = "";

type Session = {
  id: string;
  root: string;
  name: string;
  queue: Queue;
  resolvedKey?: string;
  clock: number;
};
let session: Session | null = null;
type Queue = ReturnType<typeof reviewAuditQueue> | ReturnType<typeof durableReviewAuditQueue>;
let queue: Queue | null = null;
const nativeQueues = new Map<string, ReturnType<typeof durableReviewAuditQueue>>();
let lastFrame = 0;
let storageError = "";
let uploadError = "";
let materializationError = "";
// Keep events visible to the close/update barrier even before the asynchronous
// directory key has been computed. Failed writes retain the original ID/time.
const pendingWrites = new Map<string, { session: Session; event: Omit<ReviewAuditEvent, "episodeKey"> }>();
let writing: Promise<void> | null = null;
let paused = false;

function materializePendingReviewAudit(): Promise<void> {
  if (writing) return writing;
  writing = Promise.resolve().then(async () => {
    for (const [id, pending] of pendingWrites) {
      const current = pending.session;
      if (!current.resolvedKey) {
        const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(current.root));
        current.resolvedKey = Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
      }
      current.queue.push({ ...pending.event, episodeKey: current.resolvedKey });
      pendingWrites.delete(id);
    }
    materializationError = "";
    report();
  }).catch(error => {
    materializationError = `审核记录尚未落盘，请保持应用打开并重试：${String(error)}`;
    report();
    throw error;
  }).finally(() => { writing = null; });
  return writing;
}
export function getReviewSyncStatus(): ReviewSyncStatus | null {
  if (!queue || !("snapshot" in queue)) return null;
  const value = queue.snapshot();
  const waiting = [...pendingWrites.values()].filter(write => write.session.queue === queue);
  const times = waiting.map(write => write.event.occurredAtMs);
  if (value.pending) times.push(value.oldestPendingAtMs ?? NaN);
  return {
    ...value, owner: activeOwner,
    pending: value.pending === null ? null : value.pending + waiting.length,
    volatile: value.volatile + waiting.length,
    oldestVolatileAtMs: waiting.reduce((time: number | null, write) => Math.min(time ?? Infinity, write.event.occurredAtMs), value.oldestVolatileAtMs),
    oldestPendingAtMs: times.length && times.every(time => Number.isSafeInteger(time) && time > 0) ? times.reduce((a, b) => Math.min(a, b)) : null,
    localError: waiting.length && materializationError ? materializationError : value.localError,
  };
}
const report = () => {
  window.dispatchEvent(new CustomEvent("review-audit-status", {
    detail: [materializationError, storageError, uploadError].filter(Boolean).join("；"),
  }));
  window.dispatchEvent(new CustomEvent("review-audit-snapshot", { detail: getReviewSyncStatus() }));
};

export function configureReviewAudit(username: string, serviceId: string) {
  const owner = `${serviceId}:${username}`;
  let next: Queue;
  if (isTauriRuntime()) {
    let native = nativeQueues.get(owner);
    if (!native) {
      native = durableReviewAuditQueue(localStorage, owner, {
        status: () => getReviewAuditQueueStatus(username, serviceId),
        persist: (events) => persistReviewAudit(username, serviceId, events),
        flush: (retryBlocked) => flushReviewAuditQueue(username, serviceId, retryBlocked),
      }, (message) => {
        if (queue === native) { storageError = message; uploadError = ""; report(); }
      });
      nativeQueues.set(owner, native);
    }
    next = native;
  } else next = reviewAuditQueue(
    localStorage,
    `${serviceId}:${username}`,
    (events) => sendReviewAudit(username, serviceId, events),
  );
  queue = next;
  activeOwner = owner;
  paused = false;
  storageError = "";
  uploadError = "";
  async function flush() {
    try {
      await materializePendingReviewAudit();
      await next.flush();
      if (queue === next) {
        uploadError = "";
        if (!isTauriRuntime() && !next.volatileCount()) storageError = "";
        report();
      }
    } catch (error) {
      if (queue === next) {
        uploadError = `审核操作待补传：${String(error)}`;
        report();
      }
    }
  }
  report();
  void (async () => { if ("refresh" in next) await next.refresh(); if (queue === next) await flush(); })();
  const timer = window.setInterval(() => {
    void flush();
  }, 2000);
  window.addEventListener("online", flush);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", flush);
    if (queue === next) { queue = null; activeOwner = ""; report(); }
  };
}

export async function retryReviewAudit(): Promise<number> {
  await materializePendingReviewAudit();
  if (!queue) return 0;
  return "persist" in queue ? queue.flush(true) : queue.flush();
}

export async function persistPendingReviewAudit(): Promise<void> {
  await materializePendingReviewAudit();
  for (const native of nativeQueues.values()) await native.persist();
  if (pendingWrites.size || queue?.volatileCount()) throw Error("监管记录尚未保存，暂不能关闭或切换数据");
}

export async function pauseAndPersistReviewAudit(): Promise<() => void> {
  // Freeze recording until logout or installation finishes so no new volatile
  // events appear after draining. A failed exit can resume the same session.
  paused = true;
  try { await persistPendingReviewAudit(); }
  catch (error) { paused = false; throw error; }
  return () => { paused = false; };
}

export function requireReviewAuditSession(root: string): void {
  if (paused || !queue || !session || session.root !== root || session.queue !== queue)
    throw Error("审核操作记录未就绪，请保持当前数据打开并重试");
}

export async function createDeferredReviewEvent(root: string, name: string, action: "saved" | "approved" | "rejected", reason: string): Promise<ReviewAuditEvent> {
  requireReviewAuditSession(root);
  const current = session!;
  const episodeKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(root))), byte => byte.toString(16).padStart(2, "0")).join("");
  return { eventId: crypto.randomUUID(), sessionId: current.id, episodeKey, episodeName: name.slice(0, 256), action,
    occurredAtMs: Date.now(), elapsedMs: Math.max(0, Math.round(performance.now() - current.clock)), details: { reason, target: "本机待写回审核结果" } };
}

// The exact submission ID/time is shared with the durable result and NAS QC.
// Replays reuse it, rather than inventing another successful review operation.
export function enqueueCommittedReviewEvent(event: ReviewAuditEvent): void {
  if (!queue) throw Error("审核记录队列尚未就绪，请保持当前数据打开并重试");
  queue.push(event);
}
export async function recordCommittedReviewEvent(event: ReviewAuditEvent): Promise<void> {
  enqueueCommittedReviewEvent(event);
  await persistPendingReviewAudit();
}

export async function reviewReceiptValue(root: string, event: ReviewAuditEvent, storage: "local" | "nas", sourceName?: string): Promise<string> {
  const path = root.replaceAll("\\", "/").split("/").filter(Boolean);
  const index = path.findIndex(part => part.toLowerCase() === "delta-d1" || part === "一汽data");
  const relative = index < 0 ? null : path.slice(index).join("/").toLowerCase();
  const identityKey = relative ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(relative))), byte => byte.toString(16).padStart(2, "0")).join("") : null;
  return JSON.stringify({ schema: "delta.review-receipt.v1", storage, submissionId: event.eventId, identityKey,
    dataset: index < 0 ? null : path[index].toLowerCase(),
    channel: sourceName === "skeleton.description.json" ? "skeleton" : "action", originalDurationMs: event.details.durationMs ?? null,
    batch: event.details.target?.toString().startsWith("批量不通过") ?? false });
}

export function beginReviewAudit(root: string, name: string) {
  endReviewAudit();
  if (!queue) {
    storageError = "审核记录队列尚未就绪，无法开始审核计时，请重新登录后重试";
    report();
    return () => {};
  }
  const current: Session = {
    id: crypto.randomUUID(),
    root,
    name,
    clock: performance.now(),
    queue,
  };
  session = current;
  lastFrame = 0;
  recordReviewInteraction("loaded");
  const heartbeat = window.setInterval(() => {
    if (!document.hidden) recordReviewInteraction("heartbeat");
  }, 15000);
  return () => {
    clearInterval(heartbeat);
    if (session === current) endReviewAudit();
  };
}
export function endReviewAudit() {
  if (session) recordReviewInteraction("closed");
  session = null;
}
export function recordReviewInteraction(
  action: ReviewAction,
  details: ReviewDetails = {},
  root?: string,
) {
  reviewAuditRecorder(root)(action, details);
}

// Bind asynchronous saves to the originating session, even after navigation.
export function reviewAuditRecorder(root?: string) {
  const current = session;
  return (action: ReviewAction, details: ReviewDetails = {}) => {
    if (paused || !current || (root && current.root !== root)) return;
    const occurredAtMs = Date.now(),
      elapsedMs = Math.max(0, Math.round(performance.now() - current.clock));
    const eventId = crypto.randomUUID();
    const normalized = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 2000) : value,
      ]),
    );
    pendingWrites.set(eventId, {
      session: current,
      event: {
        eventId,
        sessionId: current.id,
        episodeName: current.name.slice(0, 256),
        action,
        occurredAtMs,
        elapsedMs,
        details: normalized,
      },
    });
    report();
    void materializePendingReviewAudit().catch(() => { /* Retained and reported above. */ });
  };
}
export function updateReviewFrame(frame: number) {
  lastFrame = frame;
}

export async function recordBatchRejection(root: string, name: string, revision: string, reason: string, elapsedMs: number) {
  const targetQueue = queue;
  if (!targetQueue) throw Error("审核结果已保存，但监管队列未就绪，请勿关闭应用");
  const episodeKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(root))), byte => byte.toString(16).padStart(2, "0")).join("");
  targetQueue.push({ eventId: crypto.randomUUID(), sessionId: crypto.randomUUID(), episodeKey,
    episodeName: name.slice(0, 256), action: "rejected", occurredAtMs: Date.now(), elapsedMs: Math.max(0, Math.round(elapsedMs)),
    details: { target: "批量不通过", revision, reason } });
  if ("persist" in targetQueue) await targetQueue.persist();
  if (targetQueue.volatileCount()) throw Error("审核结果已保存，但监管记录尚未落盘，请先恢复同步");
}
export function recordReviewSeek(
  frame: number,
  mediaTimeMs: number,
  frameFrom: number,
) {
  recordReviewInteraction("seek", { frameFrom, frameTo: frame, mediaTimeMs });
  lastFrame = frame;
}

export function observeReviewInteractions() {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (pendingWrites.size || [...nativeQueues.values()].some((item) => item.volatileCount()) || queue?.volatileCount()) event.preventDefault();
  };
  let drag: {
    target: string;
    start: number;
    frame: number;
    session: Session | null;
  } | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  function targetName(target: EventTarget | null) {
    if (
      !(target instanceof Element) ||
      target.closest(".auth-shell, .profile-editor-dialog, .audit-sync-notice")
    )
      return "";
    const control = target.closest(
      "button, input, select, textarea, [role='slider']",
    );
    if (!control || control.matches("input[type='password']")) return "";
    return (
      control.getAttribute("aria-label") ||
      control.getAttribute("title") ||
      control.textContent ||
      control.tagName
    )
      .trim()
      .slice(0, 200);
  }
  const click = (event: Event) => {
    const target = targetName(event.target);
    if (target) recordReviewInteraction("control", { target });
  };
  const key = (event: KeyboardEvent) => {
    if (
      (event.target as Element)?.closest(
        "input:not([type='range']), textarea, [contenteditable='true']",
      )
    )
      return;
    if (
      [
        "Space",
        "Enter",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
      ].includes(event.code)
    )
      recordReviewInteraction("shortcut", { value: event.code });
  };
  const down = (event: PointerEvent) => {
    if (
      (event.target as Element)?.closest(
        "input[type='range'], .review-edge, .skeleton-canvas, .sidebar-resize-handle",
      )
    ) {
      drag = {
        target: targetName(event.target) || "调整视图",
        start: performance.now(),
        frame: lastFrame,
        session,
      };
    }
  };
  const up = () => {
    if (drag && drag.session === session)
      recordReviewInteraction("drag", {
        target: drag.target,
        frameFrom: drag.frame,
        frameTo: lastFrame,
        durationMs: Math.round(performance.now() - drag.start),
      });
    drag = null;
  };
  const focus = () =>
    recordReviewInteraction(document.hidden ? "blur" : "focus");
  const scroll = (event: Event) => {
    clearTimeout(scrollTimer);
    const target =
      event.target instanceof Element
        ? event.target.getAttribute("aria-label") || event.target.className
        : "页面";
    const owner = session;
    scrollTimer = setTimeout(() => {
      if (owner === session)
        recordReviewInteraction("scroll", {
          target: String(target).slice(0, 200),
        });
    }, 250);
  };
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", up, true);
  document.addEventListener("visibilitychange", focus);
  document.addEventListener("scroll", scroll, true);
  window.addEventListener("pagehide", endReviewAudit);
  window.addEventListener("beforeunload", beforeUnload);
  return () => {
    clearTimeout(scrollTimer);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", up, true);
    document.removeEventListener("visibilitychange", focus);
    document.removeEventListener("scroll", scroll, true);
    window.removeEventListener("pagehide", endReviewAudit);
    window.removeEventListener("beforeunload", beforeUnload);
  };
}
