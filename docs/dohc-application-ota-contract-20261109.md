# DOHC 应用 OTA 源码接口映射

日期：2026-11-09。本文只核对用户提供的源码材料，不表示 Manager 已接入接口或设备已部署该版本。首期范围为 DOHC 应用 release；kernel、rootfs、bootloader 和板级固件不在范围内。

## 材料与可信边界

- 输入：`/home/descfly/Downloads/DOHC应用OTA接口源码_6f91b01.zip`。
- ZIP SHA-256：`77a5b761c39a5e1d07da3d56c5fa6c644398ce39163316a8a5cc73205b8afc72`。
- 包声明源提交：`6f91b01ddb5052eafe22794e769c2cb5e5abc6d8`；37 个源码文件及配套摘录的 hash 均与包内清单一致。包内一致性不能独立证明 Git 提交来源或目标设备部署状态。
- 独立提取目录：`/home/descfly/diagnostics/dohc-ota-source-6f91b01-20261109/`；核验记录为其 `verification.json`。未覆盖 `/home/descfly/DOHC_workspace` 的旧 checkout。

下表路径均相对此目录的 `source/`。收到源码后，之前“只有摘录、无法核对实现”的缺项已关闭；已通过真实健康报告读取到 DOHC 1.1.1；设备 OTA 部署、USB OTA 端点和线上 origin 仍待确认。

## 已确认的设备端契约

| 项目 | 源码证据 | 核对结果与 Manager 边界 |
| --- | --- | --- |
| 正式制品 | `docs/installation.md:33`；`device_management/updater.py:314`、`:850` | 正式应用 OTA 使用 `.deb`；实现同时兼容历史 `.tar.gz`，`DOHC_OTA_REQUIRE_DEB` 控制强制 deb，类配置默认 false。不能声称代码无条件拒绝 tar；正式接入必须确认目标启用 deb 门禁 |
| schema | `device_management/updater.py:66` | `dohc.updater.request.v1`、`dohc.updater.response.v1`、`dohc.ota.operation.v1`、`dohc.ota.channel.v1`、`dohc.ota.release-manifest.v1` |
| 验签与大小 | `device_management/updater.py:96`、`:759`、`:2266` | JSON 上限 1 MiB；channel 与 manifest 使用 Ed25519 验签，原始签名为 64 字节。保留被签名字节，不重新序列化后代替原文；不使用 Manager 自身更新器密钥 |
| 身份与兼容 | `device_management/updater.py:808`、`:850` | channel/manifest 对齐 release ID、version、rollback index、key ID；校验硬件集合、文件路径/大小/SHA-256。源码规则不是当前设备已满足这些门禁的证据 |
| 制品路径 | `device_management/updater.py:881` | 限定 `/ota/v1/artifacts/<release_id>.deb` 或历史 `.tar.gz`；变更记录限定相同 release 根，不能接受任意下载 URL |
| 本地中继包 | `device_management/ap_ota.py:38`、`:565`；`device_management/updater.py:2212` | 正式集合为 `manifest.json`、`manifest.json.sig`、`changelog.json`、`changelog.md`、`artifact.deb` 五文件；底层另兼容 `artifact.tar.gz`，设备 updater 仍复验 manifest 签名及制品/变更记录摘要 |
| 中继开关/边界 | `device_management/ap_ota.py:233`、`:273` | 受 AP OTA 与总 OTA 开关共同约束。chunk 默认 1 MiB、会话默认 1800 秒且可配置；客户端应使用会话响应的 chunk size，不把默认值当固定协议 |
| 状态 | `device_management/ap_ota.py:377` | `dohc.ap-ota.portal.v1`；可含 state、result、operation_id、release_before/target、target_version、时间、failure_codes、回滚及历史结果展示信息。终态有 `SUCCESS`、`FAILED`、`ROLLBACK_FAILED`、`UP_TO_DATE`；HTTP 接收成功不能显示升级完成 |
| 取消 | `device_management/updater.py:1860` | 现有取消只接受匹配 Dashboard 来源的事务、且仅激活前；SoftAP HTTP 未提供取消路由。Manager 不能臆造 cancel 接口，不能把中止电脑上传等同设备事务取消 |
| 设备本机控制 | `device_management/ap_ota.py:720`；`deploy/systemd/dohc-updater.service` | 中继通过设备本机 Unix socket 请求 updater，服务以 root 运行；不能把本机 socket 或任意 shell 暴露给 Manager 前端 |

CID 是受控 LAN 下的路由标识，不能用作设备认证凭据；软件包验签也不替代设备身份认证（包内 README、`docs/adr/0040-cid-only-trusted-lan-dashboard-control.md`）。

## SoftAP HTTP 路由映射

证据：`device_management/wifi_provisioning.py:29`、`:599`、`:621`、`:718`、`:803`。源码默认绑定 SoftAP `192.168.4.1:80`；这是该服务的默认配置，不能推断预留地址或 USB 网关采用相同 scheme/端口/路由。

| 方法与路径 | 请求/响应 | 影响 |
| --- | --- | --- |
| `GET /ota/status` | portal 状态，schema 为 `dohc.ap-ota.portal.v1` | 查询设备事务；Manager 尚未调用 |
| `POST /ota/upload/v1/session` | 精确请求 `{schema:"dohc.ap-ota.upload.v1",action:"begin",files:[{name,size,sha256},…]}`；202 响应含 upload_id、chunk_size、files | 在设备创建上传会话并预留文件，是写操作；只允许一活动会话 |
| `GET /ota/upload/v1/session/<id>` | `dohc.ap-ota.upload.v1`，每个文件含 received 分块索引和 chunks 总数 | 查询续传状态，不代表事务已激活 |
| `PUT /ota/upload/v1/session/<id>/files/<name>/chunks/<index>` | 二进制分块，可带 `X-AP-OTA-Chunk-SHA256`；重复分块必须内容一致 | 写设备暂存；路径及大小受设备校验 |
| `POST /ota/upload/v1/session/<id>/complete` | 202 `dohc.ap-ota.accepted.v1`，含 operation_id、release_id | **校验文件后直接请求 updater 开始升级**；不能用作无副作用的“上传完成检查” |
| `POST /ota/upload` | 历史整包路径 | 亦会交接 updater；首期不开放第二套上传路径 |

`begin` 的 HTTP handler 先写 accepted schema，再用会话结果展开覆盖；实际成功 body 的 schema 是 `dohc.ap-ota.upload.v1`。适配器须按实际实现和对应版本 fixture 验证，不能只凭 HTTP 202 猜 schema。

## 尚未确认与下一步

| 缺项 | 需要的材料/验证 | 未取得前的行为 |
| --- | --- | --- |
| 目标设备 OTA 部署 | 健康查询已读到 DOHC 1.1.1 / release g9665bcefaed0，仍需 OTA 服务/配置及该版本契约 | 不把源码包版本当成设备版本或健康接口当成 OTA 服务 |
| Type-C 服务暴露 | 设备团队确认 USB 接口上的监听地址/端口/方法、身份与配对规则、版本能力；源码默认 SoftAP 不能直接移用 | 1.6.5 仅增加已确认的 USB 网关 GET /health:80；不请求升级端点或扫描 |
| 预留 origin | `deltadevice.cn:4174/ota/latest` 与 `/ota/v1` 的关系、正式 scheme、API/认证及实际部署版本 | `config/d1-manager.json` 保持 scheme null、enabled false、waiting_interface；不发 DNS/HTTP(S) |
| 信任根及兼容 | 经认可的公钥/key ID、轮换策略、签名样包、允许型号/revision 和目标版本规则 | 不下载、上传、触发升级或提供可用升级按钮 |
| 接入验证 | 先离线契约 fixtures/伪服务，再经授权的只读设备版本查询；实际 OTA 需另行明确批准和恢复条件 | 不把材料审查或 CI 测试冒充实机 OTA 成功 |

`release_server/` 是参考实现及测试对象，仍含历史 tar 路径；包 README 明确它不代表 Dashboard Factory 权威在线服务。不能用其路由覆盖正式 deb 契约，也不能据此访问未知线上端点。

本轮只做源码文本/hash 核验与接口映射，没有运行该包的上游测试，没有部署设备服务、下载制品或发生设备 OTA 流量。Type-C 的 Windows 真实链路验证另见 [D1 Manager 产品与实现契约](d1-manager.md)。
