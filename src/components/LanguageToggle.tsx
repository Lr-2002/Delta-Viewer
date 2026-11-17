import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Languages } from "lucide-react";
import { setLanguage, useLanguage } from "../lib/i18n";

export function LanguageToggle() {
  const language = useLanguage();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    // Native modal dialogs make the rest of the document inert. Put the same
    // control inside the active dialog without moving or remounting its form.
    const update = () => setTarget([...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1) ?? document.querySelector<HTMLElement>(".topbar-actions"));
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    update();
    return () => observer.disconnect();
  }, []);
  const button = <button type="button" className="language-toggle" lang={language === "zh" ? "en" : "zh-CN"}
    aria-label={language === "zh" ? "Switch to English" : "切换为中文"}
    title={language === "zh" ? "Switch all interface text to English" : "将全部界面切换为中文"}
    onClick={() => setLanguage(language === "zh" ? "en" : "zh")}><Languages size={15}/><span>{language === "zh" ? "English" : "中文"}</span></button>;
  return target ? createPortal(<div className={target instanceof HTMLDialogElement ? "language-modal-switch" : "language-toolbar-switch"}>{button}</div>, target) : button;
}
