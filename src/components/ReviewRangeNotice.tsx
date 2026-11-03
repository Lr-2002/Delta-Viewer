import { findReviewOverlap } from "../lib/machine-annotation";
import { useMemo } from "react";
import type { ReviewSegment } from "../types";

export function ReviewRangeNotice({ segments, onChoose, skeletonMode = false }: { segments: ReviewSegment[]; onChoose: (index: number) => void; skeletonMode?: boolean }) {
  const overlap = useMemo(()=>findReviewOverlap(segments),[segments]);
  const rows = useMemo(()=>segments.filter(item=>!item.deleted).sort((a,b)=>a.startFrame-b.startFrame || a.sourceIndex-b.sourceIndex),[segments]);
  if (!overlap) return null;
  return <div className="machine-boundary-warning" role="alert" aria-label="片段范围重叠">
    <strong>片段范围重叠，请核对后再{skeletonMode ? "保存" : "通过"}</strong>
    <p>{[overlap.previous,overlap.current].map((row,i)=><span key={row.sourceIndex}>{i ? " 与 " : ""}<button type="button" className="review-user-link" onClick={()=>onChoose(row.sourceIndex)}>片段 {rows.findIndex(item=>item.sourceIndex===row.sourceIndex)+1} [{row.startFrame}, {row.endFrame+1})</button></span>)} 包含重复帧。</p>
    <p>当前内容仍可查看、修改{skeletonMode ? "" : "并保存本机草稿"}；修正重叠后才能{skeletonMode ? "保存" : "通过"}。结束帧不包含在片段内，连续片段的上一段结束值应等于下一段开始值。旧结果不会自动改写。</p>
  </div>;
}

export function RestoreReviewDialog({ disabled, onCancel, onConfirm, skeletonMode = false }: { disabled: boolean; onCancel: () => void; onConfirm: () => void; skeletonMode?: boolean }) {
  return <dialog className="text-quality-dialog segment-restore-dialog" aria-label="恢复交叠的删除历史" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={onCancel}>
    <h2>删除历史包含交叠范围</h2>
    <p>连续删除或覆盖编辑后，历史片段可能包含重复帧，不能直接全部叠加。</p>
    <p>确认后按起始帧从小到大恢复，同起点先恢复较短片段；已恢复的帧从后续片段中扣除，完全被覆盖的历史片段保持删除。文字保留在对应片段中。</p>
    <p>{skeletonMode ? "确认后将按上述规则保存骨架片段，请逐段回放核对。" : "这只会生成待核对草稿，不代表还原了最初的人工切分。请逐段回放核对，审核通过后才写入人工结果。"}</p>
    <footer><button autoFocus className="button button-secondary" onClick={onCancel}>取消</button><button className="button button-primary" disabled={disabled} onClick={onConfirm}>生成无重叠草稿并核对</button></footer>
  </dialog>;
}
