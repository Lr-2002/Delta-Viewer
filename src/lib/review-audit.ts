import { sendReviewAudit } from "./backend";
import { reviewAuditQueue } from "./review-audit-queue";
import type { ReviewAction, ReviewDetails } from "./review-audit-types";

type Session = {
  id: string;
  root: string;
  name: string;
  key: Promise<string>;
  resolvedKey?: string;
  clock: number;
};
let session: Session | null = null;
let queue: ReturnType<typeof reviewAuditQueue> | null = null;
let lastFrame = 0;
let storageError = "";
let uploadError = "";
let pendingWrites = Promise.resolve();
const report = () =>
  window.dispatchEvent(
    new CustomEvent("review-audit-status", {
      detail: storageError || uploadError,
    }),
  );

export function configureReviewAudit(username: string, serviceId: string) {
  const next = reviewAuditQueue(
    localStorage,
    `${serviceId}:${username}`,
    (events) => sendReviewAudit(username, serviceId, events),
  );
  queue = next;
  storageError = "";
  uploadError = "";
  async function flush() {
    try {
      await pendingWrites;
      await next.flush();
      if (queue === next) {
        uploadError = "";
        if (!next.volatileCount()) storageError = "";
        report();
      }
    } catch (error) {
      if (queue === next) {
        uploadError = `审核操作待补传：${String(error)}`;
        report();
      }
    }
  }
  void flush();
  const timer = window.setInterval(() => {
    void flush();
  }, 2000);
  window.addEventListener("online", flush);
  return () => {
    clearInterval(timer);
    window.removeEventListener("online", flush);
    if (queue === next) queue = null;
  };
}

export function beginReviewAudit(root: string, name: string) {
  endReviewAudit();
  const current: Session = {
    id: crypto.randomUUID(),
    root,
    name,
    clock: performance.now(),
    key: crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(root))
      .then((buffer) =>
        Array.from(new Uint8Array(buffer), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      ),
  };
  session = current;
  void current.key.then((key) => {
    current.resolvedKey = key;
  });
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
  const current = session,
    targetQueue = queue;
  return (action: ReviewAction, details: ReviewDetails = {}) => {
    if (!current || !targetQueue || (root && current.root !== root)) return;
    const occurredAtMs = Date.now(),
      elapsedMs = Math.max(0, Math.round(performance.now() - current.clock));
    const eventId = crypto.randomUUID();
    const normalized = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 2000) : value,
      ]),
    );
    const write = (episodeKey: string) => {
      try {
        targetQueue.push({
          eventId,
          sessionId: current.id,
          episodeKey,
          episodeName: current.name.slice(0, 256),
          action,
          occurredAtMs,
          elapsedMs,
          details: normalized,
        });
      } catch (error) {
        storageError = `审核记录暂存于内存，关闭前需恢复同步：${String(error)}`;
        report();
      }
    };
    if (current.resolvedKey) write(current.resolvedKey);
    else
      pendingWrites = pendingWrites.then(async () => write(await current.key));
  };
}
export function updateReviewFrame(frame: number) {
  lastFrame = frame;
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
      target.closest(".auth-shell, .profile-editor-dialog")
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
  };
}
