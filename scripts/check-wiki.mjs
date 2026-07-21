#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wikiRoot = path.join(root, "docs/wiki");
const requiredPages = ["Home.md", "_Sidebar.md"];

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    return null;
  }
  const withoutAnchor = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutAnchor) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    throw new Error(`invalid URL encoding in Wiki link: ${rawTarget}`);
  }
  return decoded.endsWith(".md") ? decoded : `${decoded}.md`;
}

async function main() {
  const entries = (await readdir(wikiRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  for (const required of requiredPages) {
    if (!entries.includes(required)) throw new Error(`missing required Wiki page: ${required}`);
  }

  const sidebar = await readFile(path.join(wikiRoot, "_Sidebar.md"), "utf8");
  const sidebarTargets = new Set();
  const broken = [];
  for (const fileName of entries) {
    const filePath = path.join(wikiRoot, fileName);
    const [contents, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    if (info.size === 0 || !contents.trim().startsWith("#")) {
      broken.push(`${fileName}: page must be non-empty and start with a heading`);
    }
    const linkPattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    for (const match of contents.matchAll(linkPattern)) {
      const target = localTarget(match[1]);
      if (!target) continue;
      const resolved = path.resolve(wikiRoot, target);
      if (path.dirname(resolved) !== wikiRoot || !entries.includes(path.basename(resolved))) {
        broken.push(`${fileName}: broken local link ${match[1]}`);
      }
      if (fileName === "_Sidebar.md") sidebarTargets.add(path.basename(resolved));
    }
  }

  for (const page of entries) {
    if (page !== "_Sidebar.md" && !sidebarTargets.has(page)) {
      broken.push(`_Sidebar.md: missing link to ${page}`);
    }
  }
  if (broken.length > 0) throw new Error(`Wiki validation failed:\n${broken.join("\n")}`);
  console.log(`Checked ${entries.length} Wiki pages; all local links are valid.`);
}

main().catch((error) => {
  console.error(`[check-wiki] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
