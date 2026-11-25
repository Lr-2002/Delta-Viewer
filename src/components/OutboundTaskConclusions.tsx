import {useEffect, useRef, useState} from "react";
import {t, tr} from "../lib/i18n";
import {listOutboundBatches, outboundError, type OutboundBatch, type OutboundDecisionValue, type OutboundProtocol, type OutboundRecording} from "../lib/outbound-review";

const conclusions = {
  valid: "有效",
  invalid: "无效",
  anomalous: "异常",
  pending: "未审核",
} as const;
export type ConclusionFilter = "" | OutboundDecisionValue | "pending";
type Summary = Pick<OutboundRecording, "id" | "name" | "decision">;
type BatchDetails = {key: string; recordings: Summary[]; error?: string};
const batchKey = (batch: OutboundBatch) => JSON.stringify([batch.id, batch.version, batch.total]);
const savedReason = (row: Summary) => row.decision?.reason?.trim() ?? "";

function currentDetails(batch: OutboundBatch, details?: BatchDetails) {
  return details?.key === batchKey(batch) ? details : undefined;
}

function matchesReason(row: Summary, filter: OutboundDecisionValue, reason: string) {
  return row.decision?.value === filter && (!reason || savedReason(row) === reason);
}

export function OutboundConclusionFilter({value, onChange}: {value: ConclusionFilter; onChange: (value: ConclusionFilter) => void}) {
  return <label className="outbound-company-filter">
    {t("审核结论")}
    <select className="outbound-conclusion-filter" value={value} onChange={event=>onChange(event.currentTarget.value as ConclusionFilter)}>
      <option value="">{t("全部结论")}</option>
      {Object.entries(conclusions).map(([key, label])=><option key={key} value={key}>{t(label)}</option>)}
    </select>
  </label>;
}

export function batchConclusionCount(batch: OutboundBatch, filter: Exclude<ConclusionFilter, "">) {
  return filter === "pending" ? batch.total - batch.reviewed - (batch.reviewedElsewhere?.length ?? 0) : batch[filter] ?? 0;
}

export function outboundConclusionReasons(batches: OutboundBatch[], details: Record<string, BatchDetails>, filter: "invalid" | "anomalous") {
  const counts = new Map<string, number>();
  let total = 0;
  for (const batch of batches) {
    total += batchConclusionCount(batch, filter);
    const rows = batch.recordings.length ? batch.recordings : currentDetails(batch, details[batch.id])?.recordings ?? [];
    for (const row of rows) {
      const reason = savedReason(row);
      if (row.decision?.value === filter && reason) counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  const reasons = [...counts].map(([reason, count]) => ({reason, count}));
  reasons.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason, "zh-CN"));
  return {reasons, total};
}

export function batchMatchesReason(batch: OutboundBatch, details: BatchDetails | undefined, filter: "invalid" | "anomalous", reason: string) {
  const result = currentDetails(batch, details);
  if (!batch.recordings.length && (!result || result.error)) return true;
  return (batch.recordings.length ? batch.recordings : result?.recordings ?? []).some(row => matchesReason(row, filter, reason));
}

export function useOutboundBatchDetails(batches: OutboundBatch[], active: boolean, protocol: OutboundProtocol) {
  const [details, setDetails] = useState<Record<string, BatchDetails>>({});
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!active) return;
    const requests = inFlight.current;
    for (const batch of batches) {
      if (requests.size >= 3) break;
      const key = batchKey(batch);
      if (batch.recordings.length || details[batch.id]?.key === key || requests.has(batch.id)) continue;
      requests.add(batch.id);
      void listOutboundBatches(batch.id, protocol).then(result => {
        const detail = result.batches.find(item => item.id === batch.id);
        if (!detail) throw Error("OUTBOUND_BATCH_NOT_FOUND");
        return {key, recordings: detail.recordings.map(({id, name, decision}) => ({id, name, decision}))};
      }).catch(cause => ({key, recordings: [], error: outboundError(cause)}))
        .then(result => {
          requests.delete(batch.id);
          setDetails(previous => ({...previous, [batch.id]: result}));
        });
    }
  }, [active, batches, details, protocol]);
  function retry(id: string) {
    setDetails(previous => {
      const next = {...previous};
      delete next[id];
      return next;
    });
  }
  return {details, retry};
}

export function OutboundBatchConclusions({batch, filter, reason, details, retry}: {
  batch: OutboundBatch; filter: Exclude<ConclusionFilter, "">; reason: string; details?: BatchDetails; retry: () => void;
}) {
  const result = currentDetails(batch, details);
  if (!batch.recordings.length && result?.error) return <div className="outbound-conclusion-status">
    <p role="alert">{t("录制明细读取失败。{0}", [tr(result.error)])}</p>
    <button className="button button-secondary" type="button" onClick={retry}>{t("重试读取明细")}</button>
  </div>;
  if (!batch.recordings.length && !result) return <p className="outbound-conclusion-status" role="status">{t("正在读取录制明细…")}</p>;
  const reviewedElsewhere = new Set(batch.reviewedElsewhere);
  const recordings = (batch.recordings.length ? batch.recordings : result?.recordings ?? []).filter(item =>
    filter === "pending" ? !item.decision && !reviewedElsewhere.has(item.id)
      : matchesReason(item, filter, reason));
  if (!recordings.length) return <p className="outbound-conclusion-status">{t("本批次没有符合筛选条件的录制")}</p>;
  return <ul className="outbound-conclusion-recordings" aria-label={t("符合筛选条件的录制")}>
    {recordings.map(item => <li key={item.id}>
      <strong>{item.name || item.id}</strong>
      <span className={filter}>{t(conclusions[filter])}</span>
      {(filter === "invalid" || filter === "anomalous") && <p>{t("原因：{0}", [tr(savedReason(item) || t("未填写原因"))])}</p>}
    </li>)}
  </ul>;
}
