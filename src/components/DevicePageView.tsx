import { useState, type ReactNode } from "react";
import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import type { DevicePage } from "../lib/d1";
import { t, useLanguage } from "../lib/i18n";

interface Props {
  page: DevicePage;
  busy: boolean;
  showConnectionMode: boolean;
  connectionModeLabel: string;
  onBack: () => void;
  onRefresh: () => void;
  otaPanel: ReactNode;
}

export function DevicePageView({
  page, busy, showConnectionMode, connectionModeLabel, onBack, onRefresh, otaPanel,
}: Props) {
  useLanguage();
  const [activePanel, setActivePanel] = useState<"device" | "upgrade">("device");
  const address = `http://${page.address}/`;
  const loadKey = `${address}-${page.observedAtMs}`;
  const [loadedPage, setLoadedPage] = useState("");
  const loading = activePanel === "device" && loadedPage !== loadKey;

  return <main className="manager-device-page has-ota-panel" aria-label={t("设备原生页面")}>
    <header>
      <button className="button button-secondary" disabled={busy} onClick={onBack}>
        <ArrowLeft size={17}/>{t("返回设备管理")}
      </button>
      <div><strong>{t("设备页面 ·") + " "}{page.address}</strong><span>{address}</span></div>
      <button className="button button-secondary" disabled={busy || activePanel !== "device"} onClick={onRefresh}>
        <RefreshCw size={17} className={busy ? "spin" : undefined}/>{t("刷新页面")}
      </button>
    </header>
    {showConnectionMode && <p className="manager-actual-connection manager-device-page-connection" role="status">
      <span>{t("实际连接方式")}</span><strong>{t(connectionModeLabel)}</strong>
    </p>}
    <nav className="manager-device-page-tabs" aria-label={t("设备页面功能")}>
      <button type="button" aria-pressed={activePanel === "device"} onClick={() => setActivePanel("device")}>{t("设备页面")}</button>
      <button type="button" aria-pressed={activePanel === "upgrade"} onClick={() => setActivePanel("upgrade")}>{t("应用升级")}</button>
    </nav>
    {loading && <p className="manager-device-page-loading" role="status"><LoaderCircle size={16} className="spin"/>{t("正在打开设备页面…")}</p>}
    {/* Keep the device origin so its scripts, cookies and API requests work as in a browser. */}
    <iframe
      key={loadKey}
      hidden={activePanel !== "device"}
      src={address}
      title={t("D1 设备页面")}
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
      allow="local-network-access 'src'; local-network 'src'"
      referrerPolicy="no-referrer"
      onLoad={() => setLoadedPage(loadKey)}
    />
    <div hidden={activePanel !== "upgrade"} className="manager-device-ota-panel">{otaPanel}</div>
  </main>;
}
