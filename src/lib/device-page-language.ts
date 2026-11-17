/** Runs only in the already sandboxed device document. It changes presentation
 * nodes, never form values, request bodies, scripts or device identity fields. */
export function installDevicePageLanguage(token: string) {
  let language = "zh", dictionary: Record<string, string> = {};
  let patterns: {source:string;parts:string[];indices:number[];anchor:string}[] = [];
  const originals = new WeakMap<Node, { source: string; rendered: string }>();
  const attributes = new WeakMap<Element, Map<string, { source: string; rendered: string }>>();
  const skip = "script,style,textarea,input,pre,code,[contenteditable],#identity,#deviceId,#address,#deviceName,#deviceTask,#currentName,#currentTask,.camera-role,.alert-head,[data-key]";
  const translate = (source: string) => {
    if (language !== "en") return source;
    const trimmed = source.trim();
    let value = Object.hasOwn(dictionary, trimmed) ? dictionary[trimmed] : undefined;
    if (value === undefined && trimmed.length <= 4096) for (const pattern of patterns) {
      if (!trimmed.includes(pattern.anchor) || !trimmed.startsWith(pattern.parts[0]) || !trimmed.endsWith(pattern.parts.at(-1)!)) continue;
      let offset = pattern.parts[0].length, valid = true;
      const values: string[] = [];
      for (let i = 0; i < pattern.indices.length; i++) {
        const literal = pattern.parts[i + 1], end = i === pattern.indices.length - 1 ? trimmed.length - literal.length : trimmed.indexOf(literal, offset);
        if (end < offset) { valid = false; break; }
        const index = pattern.indices[i], captured = trimmed.slice(offset, end);
        if (values[index] !== undefined && values[index] !== captured) { valid = false; break; }
        values[index] = captured; offset = end + literal.length;
      }
      if (valid && offset === trimmed.length) { value = dictionary[pattern.source].replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? ""); break; }
    }
    return value === undefined ? source : source.slice(0, source.indexOf(trimmed)) + value + source.slice(source.indexOf(trimmed) + trimmed.length);
  };
  let scheduled = false;
  const update = () => {
    scheduled = false;
    document.documentElement.lang = language === "en" ? "en-US" : "zh-CN";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!parent || parent.closest(skip)) continue;
      const current = node.textContent ?? "", old = originals.get(node);
      const source = old && current === old.rendered ? old.source : current;
      // An option's implicit value equals its text. Freeze the original value
      // before localizing its label, so submitted configuration stays identical.
      if (parent instanceof HTMLOptionElement && !parent.hasAttribute("value")) parent.value = parent.textContent ?? "";
      const rendered = translate(source);
      originals.set(node, { source, rendered });
      if (current !== rendered) node.textContent = rendered;
    }
    for (const element of document.querySelectorAll("[title],[placeholder],[aria-label]")) {
      if (element.closest(skip.replace("input,", ""))) continue;
      let saved = attributes.get(element);
      if (!saved) { saved = new Map(); attributes.set(element, saved); }
      for (const name of ["title", "placeholder", "aria-label"]) {
        const current = element.getAttribute(name);
        if (current === null) continue;
        const old = saved.get(name), source = old && current === old.rendered ? old.source : current, rendered = translate(source);
        saved.set(name, { source, rendered });
        if (rendered !== current) element.setAttribute(name, rendered);
      }
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(update); } };
  window.addEventListener("message", event => {
    const message = event.data;
    if (event.source !== window.parent || message?.token !== token || message.type !== "d1-page-language" || !["zh", "en"].includes(message.language)) return;
    if (!message.messages || typeof message.messages !== "object" || Array.isArray(message.messages)) return;
    language = message.language;
    dictionary = message.messages;
    patterns = Object.keys(dictionary).filter(source => /\{\d+\}/.test(source) && /[\u3400-\u9fff]/.test(source)).map(source => {
      const parts = source.split(/\{\d+\}/g), indices = [...source.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
      return { source, parts, indices, anchor: [...parts].sort((a, b) => b.length - a.length)[0] };
    }).filter(pattern => pattern.indices.length <= 12 && pattern.parts.slice(1, -1).every(Boolean)).sort((a, b) => b.anchor.length - a.anchor.length);
    schedule();
  });
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(schedule).observe(document.body, { subtree: true, characterData: true, childList: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] });
    update();
  });
}
