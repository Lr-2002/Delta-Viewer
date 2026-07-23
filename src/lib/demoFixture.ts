import type { EpisodeSummary, StateRecord } from "../types";

export const DEMO_EPISODE_ROOT = "/demo/2026-07-13_07-34-12";
export const DEMO_FIXTURE_PATH = "/demo/fixture.json";

interface DemoFixtureStream {
  name: string;
  label: string;
  width: number;
  height: number;
  channels: number;
  totalBytes: number;
}

export interface DemoFixture {
  formatVersion: 1;
  episode: {
    name: string;
    totalFiles: number;
    totalBytes: number;
    stateCount: number;
    startTimeNs: string;
    endTimeNs: string;
    streams: DemoFixtureStream[];
  };
}

let fixturePromise: Promise<DemoFixture> | undefined;

export function loadDemoFixture(): Promise<DemoFixture> {
  fixturePromise ??= fetchDemoFixture();
  return fixturePromise;
}

export function demoEpisodeSummary(root: string, fixture: DemoFixture): EpisodeSummary {
  const { episode } = fixture;
  return {
    root,
    name: episode.name,
    totalFiles: episode.totalFiles,
    totalBytes: episode.totalBytes,
    stateCount: episode.stateCount,
    startTimeNs: episode.startTimeNs,
    endTimeNs: episode.endTimeNs,
    streams: episode.streams.map((stream) => ({
      ...stream,
      frameCount: episode.stateCount,
      firstFrame: 0,
      lastFrame: episode.stateCount - 1,
      missingFrames: [],
      missingFrameCount: 0,
    })),
  };
}

export function createDemoStates(fixture: DemoFixture): StateRecord[] {
  const { stateCount, startTimeNs, endTimeNs } = fixture.episode;
  const start = BigInt(startTimeNs);
  const end = BigInt(endTimeNs);
  const stableFrameCount = Math.min(180, stateCount);
  const stableDelta = 33_900_000n;
  const stableSpan = BigInt(Math.max(0, stableFrameCount - 1)) * stableDelta;
  const warningFrameCount = Math.max(0, stateCount - stableFrameCount);
  const warningDelta = warningFrameCount
    ? (end - start - stableSpan) / BigInt(warningFrameCount)
    : stableDelta;

  return Array.from({ length: stateCount }, (_, frameId) => {
    const timestamp = frameId < stableFrameCount
      ? start + BigInt(frameId) * stableDelta
      : start + stableSpan + BigInt(frameId - stableFrameCount + 1) * warningDelta;
    const phase = frameId / 30;
    return {
      frameId,
      captureTimeNs: String(timestamp),
      position: [Math.sin(phase) * 0.18, Math.cos(phase * 0.7) * 0.12, 0.42 + Math.sin(phase * 0.4) * 0.03],
      velocity: [Math.cos(phase) * 0.04, -Math.sin(phase * 0.7) * 0.03, Math.cos(phase * 0.4) * 0.01],
      quaternion: [0, 0, Math.sin(phase * 0.15), Math.cos(phase * 0.15)],
      euler: [Math.sin(phase * 0.3) * 0.14, Math.cos(phase * 0.22) * 0.08, Math.sin(phase * 0.17) * 0.2],
      omega: [Math.cos(phase * 0.3) * 0.04, -Math.sin(phase * 0.22) * 0.02, Math.cos(phase * 0.17) * 0.03],
      confidence: Math.max(0.92, 0.99 - (frameId % 17) / 1000),
    };
  });
}

export function demoFrameUrl(stream: string, frameId: number): string {
  const labels: Record<string, string> = {
    cam0: "Camera 0",
    cam1: "Camera 1",
    cam2: "Camera 2",
    t265_left: "T265 Left",
    t265_right: "T265 Right",
  };
  const label = labels[stream] ?? "Camera";
  const frame = String(Math.max(0, frameId)).padStart(3, "0");
  const shift = (Math.max(0, frameId) * 7) % 120;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
    <rect width="1600" height="900" fill="#161616"/>
    <path d="M0 700 L${420 + shift} 410 L${980 + shift / 2} 640 L1600 290 V900 H0Z" fill="#303030"/>
    <path d="M0 725 L${420 + shift} 435 L${980 + shift / 2} 665 L1600 315" fill="none" stroke="#777" stroke-width="8"/>
    <path d="M0 180 H1600 M0 360 H1600 M0 540 H1600 M0 720 H1600 M320 0 V900 M640 0 V900 M960 0 V900 M1280 0 V900" stroke="#272727" stroke-width="2"/>
    <rect x="52" y="52" width="330" height="96" fill="#0d0d0d" stroke="#8a8a8a" stroke-width="2"/>
    <text x="82" y="94" fill="#f2f2f2" font-family="Arial, sans-serif" font-size="30">${label}</text>
    <text x="82" y="128" fill="#adadad" font-family="Arial, sans-serif" font-size="24">FRAME ${frame}</text>
    <circle cx="1450" cy="96" r="14" fill="#e6e6e6"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function fetchDemoFixture(): Promise<DemoFixture> {
  let response: Response;
  try {
    response = await fetch(DEMO_FIXTURE_PATH, { cache: "no-store" });
  } catch {
    throw fixtureError("无法读取打包的样例清单");
  }
  if (!response.ok) throw fixtureError(`HTTP ${response.status}`);

  try {
    return parseDemoFixture(await response.json());
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("DEMO_FIXTURE_UNAVAILABLE")) throw reason;
    throw fixtureError("样例清单格式不正确");
  }
}

function parseDemoFixture(value: unknown): DemoFixture {
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.episode)) {
    throw fixtureError("样例清单格式不正确");
  }
  const episode = value.episode;
  const streamsValue = episode.streams;
  if (!Array.isArray(streamsValue) || streamsValue.length !== 5) {
    throw fixtureError("样例清单缺少五路图像流");
  }

  const streams = streamsValue.map((stream) => {
    if (!isRecord(stream)) throw fixtureError("样例清单包含无效图像流");
    return {
      name: requiredString(stream, "name", "样例清单包含无效图像流"),
      label: requiredString(stream, "label", "样例清单包含无效图像流"),
      width: requiredPositiveInteger(stream, "width", "样例清单包含无效图像流"),
      height: requiredPositiveInteger(stream, "height", "样例清单包含无效图像流"),
      channels: requiredPositiveInteger(stream, "channels", "样例清单包含无效图像流"),
      totalBytes: requiredPositiveInteger(stream, "totalBytes", "样例清单包含无效图像流"),
    };
  });

  return {
    formatVersion: 1,
    episode: {
      name: requiredString(episode, "name", "样例清单缺少记录标识"),
      totalFiles: requiredPositiveInteger(episode, "totalFiles", "样例清单缺少记录统计"),
      totalBytes: requiredPositiveInteger(episode, "totalBytes", "样例清单缺少记录统计"),
      stateCount: requiredPositiveInteger(episode, "stateCount", "样例清单缺少记录统计"),
      startTimeNs: requiredString(episode, "startTimeNs", "样例清单缺少记录标识"),
      endTimeNs: requiredString(episode, "endTimeNs", "样例清单缺少记录标识"),
      streams,
    },
  };
}

function fixtureError(detail: string): Error {
  return new Error(
    `DEMO_FIXTURE_UNAVAILABLE: 浏览器演示样例不可用（${detail}）。请确认 public/demo/fixture.json 已随仓库检出；桌面应用请使用“选择 SD 卡”导入本机记录。`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requiredString(record: Record<string, unknown>, key: string, error: string): string {
  const value = record[key];
  if (typeof value !== "string") throw fixtureError(error);
  return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, key: string, error: string): number {
  const value = record[key];
  if (!isPositiveInteger(value)) throw fixtureError(error);
  return value;
}
