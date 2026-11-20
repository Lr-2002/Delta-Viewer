import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Focus, MousePointer2, Play, RotateCcw, Search, X } from "lucide-react";
import { setLanguage, t, useLanguage, type Language } from "../../lib/i18n";
import { areas, lessons, type Copy, type Lesson, type Step } from "./catalog";
import { GuideScreenshot, hasGuideScreenshot } from "./GuideScreenshot";
import packageInfo from "../../../package.json";
import currentChinese from "../../../docs/manual/current.zh-CN.md?raw";
import currentEnglish from "../../../docs/manual/current.en.md?raw";
import "./guide-center.css";

const articles = import.meta.glob("../../../docs/wiki/*.md", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const storageKey = "d1-manager-guide-progress-v1";
type Progress = Record<string, number>;
type Running = { id: string; index: number };
type Box = { left: number; top: number; right: number; bottom: number };

function loadProgress(): Progress {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    const values = saved as Record<string, unknown>;
    return Object.fromEntries(lessons.flatMap(lesson => {
      const count = values[lesson.id];
      return typeof count === "number" && Number.isInteger(count) && count > 0 && count <= lesson.steps.length
        ? [[lesson.id, count]] : [];
    }));
  } catch {
    return {};
  }
}

function activeLayer() {
  return [...document.querySelectorAll<HTMLElement>("dialog[open]:not(.guide-center)")].at(-1) ??
    (document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement : document.body);
}

function visible(node: HTMLElement) {
  return node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" &&
    !node.closest("[hidden],[inert],.guide-center,.guide-overlay");
}

function normalized(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "").replace(/[()（）:：·.。]/g, "");
}

function controlName(node: HTMLElement) {
  return [
    node.getAttribute("aria-label"), node.title, node.getAttribute("placeholder"),
    node instanceof HTMLSelectElement || node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
      ? [...(node.labels ?? [])].map(label => label.textContent).join(" ") : null,
    node instanceof HTMLSelectElement ? null : node.textContent,
  ].filter(Boolean).map(part => normalized(part!));
}

function findTarget(step: Step, layer: HTMLElement) {
  if (step.target.startsWith("frame:")) {
    return layer.querySelector<HTMLElement>(".manager-device-page iframe:not([hidden])");
  }
  const targets = [...layer.querySelectorAll<HTMLElement>(step.target)].filter(visible);
  if (layer.matches(step.target) && visible(layer)) targets.unshift(layer);
  const expected = [...new Set([...step.label, t(step.label[0])].map(normalized))];
  const exact = targets.find(node => controlName(node).some(name => expected.includes(name)));
  const prefix = targets.find(node => controlName(node).some(name => expected.some(label => label.length >= 4 && name.startsWith(label))));
  const generic = ["button", "label", "summary", "input,select,textarea", "input[type=checkbox]"].includes(step.target);
  return exact ?? prefix ?? (generic ? undefined : targets[0]);
}

function getBox(target: HTMLElement, layer: HTMLElement): Box | null {
  const bounds = target.getBoundingClientRect();
  const clip = layer === document.body || layer === document.fullscreenElement ? null : layer.getBoundingClientRect();
  const left = Math.max(0, clip?.left ?? 0, bounds.left - 4);
  const top = Math.max(0, clip?.top ?? 0, bounds.top - 4);
  const right = Math.min(window.innerWidth, clip?.right ?? window.innerWidth, bounds.right + 4);
  const bottom = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight, bounds.bottom + 4);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function textFor(step: Step, language: Language) {
  const en = language === "en";
  const label = step.label[en ? 1 : 0];
  switch (step.action) {
    case "click": return en ? "Activate “" + label + "”." : "点击「" + label + "」。";
    case "change": return en ? "Enter a value or change the selection in “" + label + "”." : "在「" + label + "」输入或改变选择。";
    case "drag": return en ? "Drag “" + label + "” with your pointer." : "拖动「" + label + "」。";
    case "open": return en ? "Open “" + label + "”." : "打开「" + label + "」。";
    case "read": return en ? "Find and inspect “" + label + "”." : "找到并查看「" + label + "」。";
  }
}

function useGuideLayer() {
  const [host, setHost] = useState<HTMLElement>(() => document.body);
  const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    function sync() {
      setHost(activeLayer());
      setToolbar([...document.querySelectorAll<HTMLElement>(
        ".review-supervision-header,.app-shell:not([hidden]) .topbar-actions,.auth-brand,.topbar-actions",
      )].find(node => node.getClientRects().length > 0 && !node.closest("[hidden],[inert]")) ?? null);
    }
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "open"] });
    document.addEventListener("fullscreenchange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", sync);
    };
  }, []);
  return { host, toolbar };
}

function Spotlight({ step, host, running, count, needs, onAdvance, onExit }: {
  step: Step;
  host: HTMLElement;
  running: Running;
  count: number;
  needs?: Copy;
  onAdvance: () => void;
  onExit: () => void;
}) {
  const language = useLanguage();
  const en = language === "en";
  const [box, setBox] = useState<Box | null>(null);
  const [status, setStatus] = useState<"search" | "ready" | "disabled" | "waiting">("search");
  const anchorRef = useRef<HTMLElement | null>(null);
  const refresh = useRef<() => void>(() => undefined);
  const card = useRef<HTMLElement | null>(null);
  const [cardHeight, setCardHeight] = useState(200);
  const advance = useRef(onAdvance);
  advance.current = onAdvance;
  const exit = useRef(onExit);
  exit.current = onExit;

  useEffect(() => {
    if (!card.current) return;
    const observer = new ResizeObserver(entries => setCardHeight(entries[0].target.getBoundingClientRect().height));
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [host]);

  useLayoutEffect(() => {
    let finished = false;
    const outcomeEvent = step.after?.startsWith("event:") ? step.after.slice(6) : undefined;
    let pending: null | { node: HTMLElement | null; html: string } = null;
    let dragStart: { x: number; y: number; value?: string } | null = null;
    let scrollAttempted = false;
    let frameLocated = false;

    function done() {
      if (finished) return;
      finished = true;
      advance.current();
    }

    function result() {
      return step.after && !outcomeEvent ? [...document.querySelectorAll<HTMLElement>(step.after)].find(visible) ?? null : null;
    }

    function confirmOutcome() { if (pending) done(); }

    function update() {
      if (finished) return;
      if (pending) {
        const node = result();
        if (node && (node !== pending.node || node.outerHTML !== pending.html)) {
          done();
          return;
        }
        setStatus("waiting");
      }
      const layer = activeLayer();
      const element = step.target.startsWith("frame:") && !frameLocated ? null : findTarget(step, layer) ?? null;
      const previous = anchorRef.current;
      anchorRef.current = element;
      if (!element) {
        if (!pending) setStatus("search");
        setBox(null);
        return;
      }
      const closedOrDisabled = element.matches(":disabled,[aria-disabled=true]") || Boolean(element.closest("[aria-busy=true]"));
      if (!pending) setStatus(closedOrDisabled ? "disabled" : "ready");
      if ((!scrollAttempted || previous !== element) && !pending) {
        const rect = element.getBoundingClientRect();
        if (rect.top < 4 || rect.bottom > window.innerHeight - 4 || rect.left < 4 || rect.right > window.innerWidth - 4) {
          element.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        if (step.action !== "read" && step.action !== "drag" && !step.target.startsWith("frame:") && !closedOrDisabled) element.focus({ preventScroll: true });
        scrollAttempted = true;
      }
      const next = getBox(element, layer);
      setBox(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    }

    function accept(event: Event) {
      const anchor = anchorRef.current;
      const source = event.target;
      if (!anchor || !(source instanceof Node) || !anchor.contains(source) || anchor.matches(":disabled,[aria-disabled=true]")) return;
      if (step.action === "drag" && event instanceof PointerEvent && event.type === "pointerdown") {
        dragStart = { x: event.clientX, y: event.clientY, value: anchor instanceof HTMLInputElement ? anchor.value : undefined };
        return;
      }
      if (step.action === "read" || step.action === "click" && event.type !== "click" ||
          step.action === "open" && event.type !== "dblclick" && !(event instanceof KeyboardEvent && ["Enter", " "].includes(event.key)) ||
          step.action === "change" && event.type !== "change" ||
          step.action === "drag" && event.type !== "change") return;
      if (step.action === "change" && source instanceof HTMLInputElement && !["range", "checkbox", "radio"].includes(source.type) && !source.value.trim()) return;
      if (step.after) {
        const node = result();
        pending = { node, html: node?.outerHTML ?? "" };
        setStatus("waiting");
        // Observe the application after its own click handler, including native dialogs.
        setTimeout(update, 0);
      } else {
        setTimeout(done, 0);
      }
    }

    function endDrag(event: PointerEvent) {
      if (step.action !== "drag" || !dragStart) return;
      const start = dragStart;
      dragStart = null;
      const anchor = anchorRef.current;
      const moved = Math.abs(start.x - event.clientX) + Math.abs(start.y - event.clientY) >= 3;
      if (moved || (anchor instanceof HTMLInputElement && anchor.value !== start.value)) setTimeout(done, 0);
    }

    function keyboard(event: KeyboardEvent) {
      if (event.key !== "Escape" || document.querySelector(".shortcut-binding[aria-pressed=true]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      exit.current();
    }

    function frameReport(event: Event) {
      const report = (event as CustomEvent<{ selector: string; action: string }>).detail;
      if (!step.target.startsWith("frame:") || report?.selector !== step.target.slice(6)) return;
      if (report.action === "located" || report.action === "missing") { frameLocated = report.action === "located"; update(); }
      else if (report.action === "exit") exit.current();
      else if (frameLocated && report.action === step.action) done();
    }

    setStatus("search");
    refresh.current = () => { pending = null; scrollAttempted = false; update(); };
    document.addEventListener("click", accept, true);
    document.addEventListener("change", accept, true);
    document.addEventListener("dblclick", accept, true);
    document.addEventListener("keydown", accept, true);
    document.addEventListener("pointerdown", accept, true);
    document.addEventListener("pointerup", endDrag, true);
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("d1-guide-frame-action", frameReport);
    if (outcomeEvent) window.addEventListener(outcomeEvent, confirmOutcome);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const timer = window.setInterval(update, 120);
    update();
    if (step.target.startsWith("frame:")) window.dispatchEvent(new CustomEvent("d1-guide-frame-target", { detail: step.target.slice(6) }));
    return () => {
      finished = true;
      clearInterval(timer);
      document.removeEventListener("click", accept, true);
      document.removeEventListener("change", accept, true);
      document.removeEventListener("dblclick", accept, true);
      document.removeEventListener("keydown", accept, true);
      document.removeEventListener("pointerdown", accept, true);
      document.removeEventListener("pointerup", endDrag, true);
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("d1-guide-frame-action", frameReport);
      if (outcomeEvent) window.removeEventListener(outcomeEvent, confirmOutcome);
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      if (step.target.startsWith("frame:")) window.dispatchEvent(new CustomEvent("d1-guide-frame-target", { detail: "" }));
    };
  }, [running.id, running.index, step]);

  const displayedBox = status === "ready" && box;
  const isFrame = step.target.startsWith("frame:");
  const margin = 12;
  const width = Math.min(350, window.innerWidth - 2 * margin);
  let left = window.innerWidth - width - margin;
  let top = margin;
  if (displayedBox) {
    const center = (box.left + box.right) / 2;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, center - width / 2));
    top = box.bottom + margin;
    if (top + cardHeight > window.innerHeight - margin) top = Math.max(margin, box.top - cardHeight - margin);
    if (top < box.bottom && top + cardHeight > box.top) {
      if (box.right + width + margin < window.innerWidth) left = box.right + margin;
      else if (box.left - width - margin >= margin) left = box.left - width - margin;
      else top = Math.max(margin, window.innerHeight - cardHeight - margin);
    }
  }
  const common = en
    ? { progress: "Step", exit: "Exit guide", next: "Continue", retry: "Find control again", waiting: "Waiting for the app to confirm the result. Finish any system dialog or retry after an error.", missing: "This control is not available on the current screen.", disabled: "The control is present but unavailable. Check the operation’s prerequisites.", confirmInput: "Press Tab after changing a text field." }
    : { progress: "步骤", exit: "退出引导", next: "继续", retry: "重新定位", waiting: "正在等待软件确认结果。请完成系统弹窗中的操作，失败后可重新定位并重试。", missing: "当前界面暂时找不到这个控件。", disabled: "控件当前不可用，请确认操作条件。", confirmInput: "修改文本后按 Tab 确认输入。" };
  const shade = displayedBox && !isFrame ? [
    { inset: "0 0 auto", height: box.top },
    { top: box.top, left: 0, width: box.left, height: box.bottom - box.top },
    { top: box.top, left: box.right, right: 0, height: box.bottom - box.top },
    { top: box.bottom, left: 0, right: 0, bottom: 0 },
  ] satisfies CSSProperties[] : [];
  // When a visible native modal owns the top layer, this portal makes its controls
  // and the guide usable together without moving or remounting the modal.
  return createPortal(
    <div className="guide-overlay" data-guide-state={status}>
      {shade.map((style, index) => <div className="guide-shade" style={style} key={index} />)}
      {displayedBox && !isFrame && <div className="guide-spot" style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />}
      <section ref={card} className="guide-tip" style={{ left, top, width }} aria-label={en ? "Interactive guide" : "互动引导"}>
        <header><div><MousePointer2 size={16} />{common.progress} {running.index + 1} / {count}</div>
          <span className="guide-tip-tools"><button type="button" className="text-button" aria-label={en ? "切换为中文" : "Switch guide to English"} onClick={() => setLanguage(en ? "zh" : "en")}>{en ? "中文" : "English"}</button><button type="button" className="icon-button" onClick={onExit} aria-label={common.exit} title={common.exit}><X size={17} /></button></span>
        </header>
        <div className="guide-progress" role="progressbar" aria-valuemin={0} aria-valuemax={count} aria-valuenow={running.index}><i style={{ width: (running.index / count * 100) + "%" }} /></div>
        <div className="guide-tip-content" aria-live="polite">
          <h3>{textFor(step, language)}</h3>
          {step.detail && <p>{step.detail[en ? 1 : 0]}</p>}
          {status === "waiting" ? <p className="guide-condition">{common.waiting}</p> :
            status !== "ready" ? <p className="guide-condition">{status === "disabled" ? common.disabled : common.missing} {needs?.[en ? 1 : 0]}</p> :
            step.action === "change" && anchorRef.current?.matches("input:not([type=range]),textarea") ? <p>{common.confirmInput}</p> : null}
        </div>
        <div className="guide-tip-actions">
          <button type="button" className="text-button" onClick={onExit}>{common.exit}</button>
          {status !== "ready" && <button type="button" className="button button-secondary" onClick={() => refresh.current()}><Focus size={15} />{common.retry}</button>}
          {status === "ready" && step.action === "read" && <button type="button" className="button button-primary" onClick={onAdvance}>{common.next}<ArrowRight size={15} /></button>}
        </div>
      </section>
    </div>, host,
  );
}

function StepPicture({ step, lesson, index }: { step: Step; lesson: Lesson; index: number }) {
  const language = useLanguage();
  const en = language === "en";
  if (hasGuideScreenshot(lesson.id, index, language)) return <GuideScreenshot id={lesson.id} index={index} />;
  const area = areas.find(row => row[0] === lesson.area);
  const side = step.target.includes("sidebar") || step.target.includes("episode-list") || step.target.includes("recording-sidebar");
  const toolbar = /navigation|topbar|toolbar|\\.manager-connect-bar/.test(step.target);
  const modal = /dialog|popover|\\.preview-settings/.test(step.target);
  const picture = en ? "Control location diagram" : "界面定位图";
  return <figure className={"guide-picture " + (side ? "guide-picture-side" : toolbar ? "guide-picture-toolbar" : modal ? "guide-picture-modal" : "")} aria-label={picture}>
    <div className="guide-mock-bar"><span>D1 Manager</span><small>{area?.[en ? 2 : 1]}</small></div>
    <div className="guide-mock-layout">
      <div className="guide-mock-sidebar" aria-hidden="true"><i /><i /><i /></div>
      <div className="guide-mock-main" aria-hidden="true"><i /><i /><i /></div>
      <div className="guide-mock-control">
        <strong>{index + 1}</strong>
        {step.action === "change" ? <span className="guide-mock-input">{step.label[en ? 1 : 0]} <ChevronRight size={14} /></span> :
          step.action === "drag" ? <span className="guide-mock-slider"><i />{step.label[en ? 1 : 0]}</span> :
          <span className="button button-secondary">{step.action === "read" ? <Focus size={15} /> : <MousePointer2 size={15} />}{step.label[en ? 1 : 0]}</span>}
      </div>
    </div>
    <figcaption>{picture}</figcaption>
  </figure>;
}

function WikiArticle({ article }: { article: string }) {
  // Built-in wiki is rendered as text and headings; React escapes captured text.
  return <div className="guide-wiki-content">{article.split(/\r?\n/).filter(Boolean).map((line, index) => {
    const clean = line.replace(/^#+\s*/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*\x60]/g, "");
    if (line.startsWith("#")) return <h4 key={index}>{clean}</h4>;
    if (line === "\x60\x60\x60") return null;
    return <p key={index}>{clean}</p>;
  })}</div>;
}

export function GuideCenter() {
  const language = useLanguage();
  const en = language === "en";
  const lang = en ? 1 : 0;
  const { toolbar, host } = useGuideLayer();
  const [visibleCenter, setVisibleCenter] = useState(false);
  const [selection, setSelection] = useState(lessons[0].id);
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"steps" | "wiki" | "current">("steps");
  const [completed, setCompleted] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [progress, setProgress] = useState(loadProgress);
  const centerRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const active = lessons.find(lesson => lesson.id === running?.id);
  const name = en ? "Documentation Center" : "文档中心";
  const filter = normalized(query);
  const matches = lessons.filter(lesson => (!category || lesson.area === category) && (!filter ||
    normalized([...lesson.title, ...(lesson.needs ?? []), ...lesson.steps.flatMap(step => [...step.label, ...(step.detail ?? [])])].join(" ")).includes(filter)));
  const selected = matches.find(lesson => lesson.id === selection) ?? matches[0];
  const wiki = selected?.wiki ? articles["../../../docs/wiki/" + selected.wiki + ".md"] : undefined;
  const recent = completed ? lessons.find(lesson => lesson.id === completed) : undefined;

  useLayoutEffect(() => {
    const dialog = centerRef.current;
    if (visibleCenter && dialog && !dialog.open) dialog.showModal();
  }, [visibleCenter]);
  useEffect(() => { articleRef.current?.scrollTo({ top: 0 }); }, [selected?.id, tab]);

  function closeCenter() {
    centerRef.current?.close();
    setVisibleCenter(false);
    setCompleted(null);
    triggerRef.current?.focus();
  }

  function launch(lesson: Lesson, reset: boolean) {
    if (reset) saveProgress(lesson.id, 0);
    setCompleted(null);
    setVisibleCenter(false);
    setRunning({ id: lesson.id, index: reset ? 0 : Math.min(progress[lesson.id] ?? 0, lesson.steps.length - 1) });
  }

  function saveProgress(id: string, count: number) {
    setProgress(previous => {
      const next = { ...previous, [id]: count };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* The current session remains usable. */ }
      return next;
    });
  }

  function advanceGuide() {
    if (!running || !active) return;
    const next = running.index + 1;
    saveProgress(active.id, next);
    if (next < active.steps.length) {
      setRunning({ id: active.id, index: next });
      return;
    }
    setRunning(null);
    setCompleted(active.id);
    setSelection(active.id);
    setVisibleCenter(true);
  }

  function exitGuide() {
    if (running) setSelection(running.id);
    setRunning(null);
    setVisibleCenter(true);
  }

  const entry = <button ref={triggerRef} type="button" className={"button button-secondary guide-entry" + (toolbar ? "" : " guide-entry-fallback")} title={name}
    onClick={() => setVisibleCenter(true)}><BookOpen size={17} /><span>{name}</span></button>;

  return <>
    {!running && (toolbar ? createPortal(entry, toolbar) : entry)}
    {validRunning(active, running) && <Spotlight key={running.id + ":" + running.index} step={active!.steps[running.index]} host={host} running={running}
      count={active!.steps.length} needs={active!.needs} onAdvance={advanceGuide} onExit={exitGuide} />}
    {visibleCenter && createPortal(<dialog className="guide-center" ref={centerRef} aria-label={name} onCancel={event => { event.preventDefault(); closeCenter(); }}>
      <header className="guide-center-head"><div><BookOpen size={23} /><h1>{name}</h1><small>v{packageInfo.version}</small></div>
        <div className="guide-header-actions">
          <button className="button button-secondary" type="button" onClick={() => setLanguage(en ? "zh" : "en")} aria-label={en ? "切换为中文" : "Switch to English"}>{en ? "中文" : "English"}</button>
          <button type="button" className="icon-button" aria-label={en ? "Close documentation" : "关闭文档中心"} onClick={closeCenter}><X size={21} /></button>
        </div>
      </header>
      <div className="guide-center-body">
        <aside className="guide-library">
          <label className="guide-search"><Search size={17} /><input autoFocus aria-label={en ? "Search guides" : "搜索教程"} type="search" placeholder={en ? "Search guides" : "搜索功能、按钮或操作"} value={query} onChange={event => { setQuery(event.target.value); setCompleted(null); setTab("steps"); }} /></label>
          <label className="guide-area-field"><span>{en ? "Category" : "功能分类"}</span><select value={category} onChange={event => { setCategory(event.target.value); setCompleted(null); setTab("steps"); }}>
            <option value="">{en ? "All categories" : "全部分类"}</option>
            {areas.map(([id, zh, english]) => <option key={id} value={id}>{en ? english : zh}</option>)}
          </select></label>
          <nav aria-label={en ? "Guide topics" : "教程目录"}>
            {areas.map(([id, zh, english]) => {
              const items = matches.filter(lesson => lesson.area === id);
              return items.length ? <section key={id}><h2>{en ? english : zh}</h2>
                {items.map(lesson => <button key={lesson.id} type="button" aria-current={selected?.id === lesson.id ? "page" : undefined}
                  onClick={() => { setSelection(lesson.id); setCompleted(null); setTab("steps"); }}>
                  {progress[lesson.id] === lesson.steps.length ? <Check size={15} aria-label={en ? "Completed" : "已完成"} /> : <ChevronRight size={15} />}
                  <span>{lesson.title[lang]}</span>
                </button>)}
              </section> : null;
            })}
            {!matches.length && <p>{en ? "No guides match this search." : "没有找到匹配的教程。"}</p>}
          </nav>
        </aside>
        <main ref={articleRef} className="guide-article">
          {selected && <article aria-labelledby="guide-lesson-title">
            {recent && <div className="guide-complete" role="status"><Check size={18} /><span>{en ? "Guide completed" : "已完成互动引导"} · {recent.title[lang]}</span></div>}
            <div className="guide-article-head">
              <h2 id="guide-lesson-title">{selected.title[lang]}</h2>
              {selected.needs && <p>{selected.needs[lang]}</p>}
              {selected.writes && <p className="guide-write"><CircleHelp size={16} />{en ? "Practice on test data, a test account or a test device. Confirmations use the actual app." : "请使用测试数据、测试账号或测试设备练习。引导中的确认会执行软件的实际操作。"}</p>}
              <div className="guide-article-actions">
                <button type="button" className="button button-primary" onClick={() => launch(selected, !progress[selected.id] || progress[selected.id] === selected.steps.length)}><Play size={16} />
                  {progress[selected.id] > 0 && progress[selected.id] < selected.steps.length ? en ? "Resume guide" : "继续学习" : en ? "Start interactive guide" : "开始互动引导"}
                </button>
                <button type="button" className="button button-secondary" onClick={() => launch(selected, true)}><RotateCcw size={15} />{en ? "Learn again" : "重新学习"}</button>
              </div>
            </div>
            <div className="guide-article-tabs">
              <button type="button" className="button button-secondary" aria-pressed={tab === "steps"} onClick={() => setTab("steps")}>{en ? "Illustrated guide" : "图文教程"}</button>
              <button type="button" className="button button-secondary" aria-pressed={tab === "current"} onClick={() => setTab("current")}>{en ? "Current feature manual" : "当前功能手册"}</button>
              {wiki && <button type="button" className="button button-secondary" aria-pressed={tab === "wiki"} onClick={() => setTab("wiki")}>{en ? "Original documentation (Chinese)" : "原有文档"}</button>}
            </div>
            {tab === "current" ? <WikiArticle article={en ? currentEnglish : currentChinese} /> : tab === "wiki" && wiki ? <WikiArticle article={wiki} /> :
              <ol className="guide-steps">{selected.steps.map((step, index) => <li key={index}><div className="guide-step-copy">
                <strong>{textFor(step, language)}</strong>
                {step.detail && <p>{step.detail[lang]}</p>}
              </div><StepPicture step={step} lesson={selected} index={index} /></li>)}</ol>}
          </article>}
          {!selected && <div className="guide-empty"><Search size={29} /><p>{en ? "Try another keyword or category." : "换一个关键词或分类继续查找。"}</p>
            <button className="button button-secondary" type="button" onClick={() => { setQuery(""); setCategory(""); }}><ArrowLeft size={15} />{en ? "Show all guides" : "显示全部教程"}</button>
          </div>}
        </main>
      </div>
    </dialog>, document.body)}
  </>;
}

function validRunning(lesson: Lesson | undefined, running: Running | null): running is Running {
  return Boolean(lesson && running && lesson.steps[running.index]);
}
