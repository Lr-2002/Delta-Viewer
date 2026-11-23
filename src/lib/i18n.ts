import { useSyncExternalStore } from "react";
import english from "./messages.en.json";

export type Language = "zh" | "en";
const preferenceKey = "d1-manager-language-v1";
const listeners = new Set<() => void>();
const messages: Record<string, string> = english;
let language: Language = "zh";
try { if (localStorage.getItem(preferenceKey) === "en") language = "en"; } catch { /* Session preference remains available. */ }
export const getLanguage = () => language;
export const localeTag = () => language === "en" ? "en-US" : "zh-CN";
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLanguage() { return useSyncExternalStore(subscribe, getLanguage, getLanguage); }
export function setLanguage(next: Language) {
  if (next !== "zh" && next !== "en" || next === language) return;
  language = next;
  document.documentElement.lang = localeTag();
  try { localStorage.setItem(preferenceKey, next); } catch { /* Do not block switching when storage is unavailable. */ }
  for (const listener of listeners) listener();
}
if (typeof document !== "undefined") document.documentElement.lang = localeTag();
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === preferenceKey) setLanguage(event.newValue === "en" ? "en" : "zh");
});

export function t(source: string, values: readonly unknown[] = []): string {
  const text = language === "en" ? messages[source] ?? source : source;
  return text.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ""));
}
// A literal matcher keeps diagnostics bounded even when they contain many
// separators. There is no regular-expression backtracking over user content.
const patterns = Object.keys(messages).filter(key => /\{\d+\}/.test(key) && /[\u3400-\u9fff]/.test(key))
  .map(key => {
    const indices = [...key.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
    const literals = key.split(/\{\d+\}/g);
    return { key, indices, literals, anchor: [...literals].sort((a, b) => b.length - a.length)[0] };
  })
  .filter(pattern => pattern.indices.length <= 12 && pattern.literals.slice(1, -1).every(Boolean))
  .sort((a, b) => b.anchor.length - a.anchor.length);
function matchPattern(value: string, pattern: typeof patterns[number]): string[] | null {
  const { literals, indices } = pattern;
  if (!value.includes(pattern.anchor) || !value.startsWith(literals[0]) || !value.endsWith(literals.at(-1)!)) return null;
  const values: string[] = [];
  let offset = literals[0].length;
  for (let i = 0; i < indices.length; i++) {
    const literal = literals[i + 1];
    const end = i === indices.length - 1 ? value.length - literal.length : value.indexOf(literal, offset);
    if (end < offset) return null;
    const captured = value.slice(offset, end), index = indices[i];
    if (values[index] !== undefined && values[index] !== captured) return null;
    values[index] = captured;
    offset = end + literal.length;
  }
  return offset === value.length ? values : null;
}
const translated = new Map<string, string>();
/** Translate presentation values only. Source names, paths and editable values
 * stay outside this function at their UI bindings; payloads are never changed. */
export function tr<T>(value: T): T {
  if (language !== "en" || typeof value !== "string" || value.length > 4096 || !/[\u3400-\u9fff]/.test(value)) return value;
  const exact = messages[value];
  if (exact !== undefined) return exact as T;
  const cached = translated.get(value);
  if (cached !== undefined) return cached as T;
  for (const pattern of patterns) {
    const values = matchPattern(value, pattern);
    if (!values) continue;
    const result = t(pattern.key, values);
    if (translated.size >= 512) translated.clear();
    translated.set(value, result);
    return result as T;
  }
  return value;
}
