import { t, useLanguage } from "../lib/i18n";
export function BrandMark() {
  useLanguage();
  return <div className="brand-mark"><img src="/delta-symbol.svg" alt={t("德塔标志")} width={17} height={24} /></div>;
}
