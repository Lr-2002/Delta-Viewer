# 1.2.9 片段边界反向复原

用户反馈：向右覆盖多个片段后，向左拖回，原片段无法恢复。

## 原因

1.2.8 的 `ReviewTimeline` 仅在一次 pointer 手势内使用不变的当前片段做预览，按住时反向移动可以恢复。pointer-up 调用 `MachineAnnotationEditor.boundary`，随后保存覆盖/删除后的片段。第二次拖动以这些已修改片段为基准，`adjustReviewBoundary` 跳过已删除片段；已局部修剪的原范围也不在当前数组内。因此松手后无法反向恢复。原始机标没有被覆盖，此问题发生在人工编辑状态。

## 改动与边界

- `src/lib/machine-annotation.ts`：增加编辑器实例隔离的 `createReviewBoundaryEditor`，保存首次调整基准和最后提交数组，同一片段同一边界连续提交从基准计算；预览无副作用，提交和预览返回相同内容。
- `MachineAnnotationPanel`、`ReviewTimeline`、`ProofreadPlayer`：嵌入及独立回放共用上述预览/提交。起止两端、方向键、数字帧输入均可反向恢复。每次鼠标释放最多保存一次。
- 原本删除的片段不会复活；恢复被覆盖片段的描述和范围不恢复失效通过状态。调整保持 pending；原始源文件、历史结论、审计及 NAS 待写协议沿用现有门禁。
- 修改描述、增删/切割/手动恢复，或改为另一片段/另一端的边界调整后，以当前内容开始新调整。重新加载、账号/数据/动作骨架切换隔离基准，不允许旧快照覆盖新编辑。
- 反向复原基准仅保留在当前编辑器内存中，不跨重启；本版本不会自动修复已经保存且退出的旧版局部覆盖，既有版本历史与删除恢复仍可用。
- 无后台代码变动，不需要重启工作台、用户中心或上传服务。

## 验证

结果以本次检查日志和 `artifacts/release-check` 报告为准；隔离浏览器测试新增松手保存后反向拖动、起止两端、键盘一帧复原、后续文字保护，保留预览无写入、取消、三视口截图与原有完整回归。目标机验收仅使用本次独立 fixture，不修改实际审核数据。

已完成本地检查：`pnpm check:full` 通过（含 production build、Rust Clippy/tests 和 Tauri debug no-bundle）；`pnpm test:proofreading` 的 15 项纯逻辑、38 项浏览器回归通过；`pnpm test:concurrency:browser` 通过；发布 workflow 回归 6 项通过；Wiki 15 页链接检查通过。新增左右两端跨多段、松手后反向、多次往返、原有删除保留、不同编辑器隔离和新文字保护断言均通过。

检查报告：`artifacts/release-check/2026-10-23T10-05-01-464Z-linux-x64.json`。既有 frontend chunk-size 与 binrw future-compatibility 提示仍存在，未进行无关依赖升级。本地结果不替代三平台原生安装包与 Windows 目标机验收。
