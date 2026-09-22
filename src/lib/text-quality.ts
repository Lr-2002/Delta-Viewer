import defaults from "./text-quality-defaults.json";
export interface TextPolicy { rules: { from: string; to: string }[]; whitelist: string[] }
export const defaultTextPolicy: TextPolicy = defaults;
export interface TextIssue {
  original: string;
  suggestion: string;
  reason: string;
}

export function inspectDescription(text: string, policy: TextPolicy = defaultTextPolicy): TextIssue[] {
  const issues: TextIssue[] = [];
  const allowed = (word: string) => policy.whitelist.includes(word) || policy.whitelist.includes(text);
  for (const { from: original, to: suggestion } of policy.rules) {
    if (original && text.includes(original) && !allowed(original)) issues.push({ original, suggestion, reason: "术语／错字规则" });
  }
  for (const repeated of new Set([...text.matchAll(/([\u3400-\u9fff])\1{2,}/gu)].map(match => match[0]))) {
    if (!allowed(repeated)) issues.push({ original: repeated, suggestion: repeated.slice(0, 1), reason: "疑似重复字" });
  }
  return issues;
}

export function replaceDescription(text: string, from: string, to: string, wholeWord = false) {
  if (!from) return text;
  if (!wholeWord) return text.split(from).join(to);
  const segments = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(text)];
  const boundaries = new Set([0, text.length, ...segments.flatMap(part => [part.index, part.index + part.segment.length])]);
  let result = "", cursor = 0, offset = text.indexOf(from);
  while (offset >= 0) {
    result += text.slice(cursor, offset) + (boundaries.has(offset) && boundaries.has(offset + from.length) ? to : from);
    cursor = offset + from.length; offset = text.indexOf(from, cursor);
  }
  return result + text.slice(cursor);
}

export function inspectDescriptions(texts: string[]) {
  return texts.flatMap((text, index) => inspectDescription(text).map((issue) => ({ ...issue, index })));
}
