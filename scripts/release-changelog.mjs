#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const releaseHeadingPattern =
  /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) - (\d{4}-\d{2}-\d{2})\r?$/gm;
const sectionHeadingPattern = /^## .+\r?$/gm;
const placeholderPattern = /^(?:TBD|TODO|待补充|暂无(?:变更|内容)?)[.!。]?$/i;

function isCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseReleaseChangelog(contents, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`release changelog version must be semver, got ${version}`);
  }

  const releases = [...contents.matchAll(releaseHeadingPattern)].map((match) => ({
    version: match[1],
    date: match[2],
    heading: match[0],
    index: match.index,
  }));
  const matching = releases.filter((release) => release.version === version);
  if (matching.length === 0) {
    throw new Error(`CHANGELOG.md has no dated ${version} release heading`);
  }
  if (matching.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated ${version} release heading`);
  }
  if (releases[0]?.version !== version) {
    throw new Error(`CHANGELOG.md must list ${version} as its first dated release entry`);
  }

  const release = matching[0];
  if (!isCalendarDate(release.date)) {
    throw new Error(`CHANGELOG.md has an invalid calendar date for ${version}: ${release.date}`);
  }

  const bodyStart = release.index + release.heading.length;
  const nextSection = [...contents.matchAll(sectionHeadingPattern)].find(
    (heading) => heading.index > release.index,
  );
  const body = contents.slice(bodyStart, nextSection?.index ?? contents.length).trim();
  const changes = body
    .split(/\r?\n/)
    .map((line) => /^-\s+(\S(?:.*\S)?)\s*$/.exec(line)?.[1] ?? null)
    .filter((line) => line !== null);
  if (changes.length === 0) {
    throw new Error(`CHANGELOG.md ${version} entry must contain at least one change bullet`);
  }
  if (changes.some((change) => placeholderPattern.test(change))) {
    throw new Error(`CHANGELOG.md ${version} entry contains a placeholder instead of a change`);
  }

  return {
    version,
    date: release.date,
    body,
    changeCount: changes.length,
  };
}

export function formatReleaseChangelog(entry) {
  return `## Changelog\n\n### ${entry.version} - ${entry.date}\n\n${entry.body}\n`;
}

function parseArguments(argv) {
  const options = {
    version: null,
    input: path.join(defaultRoot, "CHANGELOG.md"),
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(
        "Usage: node scripts/release-changelog.mjs --version <semver> [--input <path>] [--output <path>]",
      );
      process.exit(0);
    }
    if (!["--version", "--input", "--output"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--version") options.version = value;
    if (argument === "--input") options.input = path.resolve(value);
    if (argument === "--output") options.output = path.resolve(value);
  }
  if (!options.version) throw new Error("--version is required");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const contents = await readFile(options.input, "utf8");
  const markdown = formatReleaseChangelog(parseReleaseChangelog(contents, options.version));
  if (options.output) {
    await writeFile(options.output, markdown, { encoding: "utf8", flag: "wx" });
  } else {
    process.stdout.write(markdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(`[release-changelog] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
