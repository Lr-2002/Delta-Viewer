import { useLanguage } from "../../lib/i18n";

type Picture = { src: string; label: string; area: readonly [left: number, top: number, width: number, height: number] };
const device = "guide-images/device-home-zh.webp";
const playback = "guide-images/local-playback-zh.webp";
const pictures: Record<string, Picture> = {
  "offline:1": { src: device, label: "设备管理区顶部的「数据工作区」", area: [20.3, 1.1, 7.5, 4.4] },
  "offline:2": { src: playback, label: "播放页顶部的「设备管理区」", area: [13, 1.2, 7.5, 4.3] },
  "usb:2": { src: device, label: "设备首页的「Type-C 连接」", area: [11.5, 23.7, 9.3, 4.8] },
  "hotspot:2": { src: device, label: "设备首页的「设备热点（AP）」", area: [21, 23.7, 10.4, 4.8] },
  "lan:2": { src: device, label: "设备首页的「局域网 IP」", area: [31.4, 23.7, 7.7, 4.8] },
  "open-recording:1": { src: playback, label: "数据工作区工具栏的「选择 SD 卡」", area: [71.2, 1.4, 6.1, 4.2] },
  "open-recording:2": { src: playback, label: "侧栏中的练习录制条目", area: [0.4, 47.6, 18, 9.8] },
  "open-recording:3": { src: playback, label: "校对区播放按钮", area: [77.8, 24.5, 2.6, 4.0] },
  "play-controls:6": { src: playback, label: "校对区倍速下拉菜单", area: [75.2, 28.4, 9.8, 4.2] },
  "play-controls:7": { src: playback, label: "校对区帧率下拉菜单", area: [86, 28.4, 9.5, 4.2] },
  "camera-status:0": { src: playback, label: "五路现有画面与两处未接入位置", area: [19.9, 23.5, 54.1, 35.3] },
  "camera-status:1": { src: playback, label: "画面下方的渲染进度", area: [19.9, 58.1, 54.1, 3.1] },
  "telemetry:4": { src: playback, label: "状态数据图及遥测数值", area: [19.9, 71.5, 54, 26] },
  "segment-bounds:2": { src: playback, label: "右侧的复核起始帧输入框", area: [75.5, 40.1, 10.7, 4.9] },
  "segment-bounds:3": { src: playback, label: "右侧不包含边界的复核结束帧输入框", area: [86.8, 40.1, 11.7, 4.9] },
  "special-tags:0": { src: playback, label: "相机下方的「添加标签」", area: [68, 63.4, 5.2, 3.8] },
  "annotation-source:0": { src: playback, label: "右上角的机标来源选择", area: [84, 17.7, 14.4, 4.9] },
  "approve:0": { src: playback, label: "校对区右下角的「通过」", area: [86.8, 83.5, 12, 4.4] },
  "reject:0": { src: playback, label: "校对区右下角的「不通过」", area: [75.4, 83.5, 11.2, 4.4] },
};

export function GuideScreenshot({ id, index }: { id: string; index: number }) {
  const language = useLanguage();
  const picture = language === "zh" ? pictures[id + ":" + index] : undefined;
  if (!picture) return null;
  const [left, top, width, height] = picture.area;
  return <figure className="guide-screenshot">
    <div>
      <img src={import.meta.env.BASE_URL + picture.src} alt={picture.label} loading="lazy" />
      <span aria-hidden="true" className="guide-screenshot-mark" style={{ left: left + "%", top: top + "%", width: width + "%", height: height + "%" }}><b>{index + 1}</b></span>
    </div>
    <figcaption>v1.11.6 实机截图 · {picture.label}</figcaption>
  </figure>;
}

export function hasGuideScreenshot(id: string, index: number, language: "zh" | "en") {
  return language === "zh" && Boolean(pictures[id + ":" + index]);
}
