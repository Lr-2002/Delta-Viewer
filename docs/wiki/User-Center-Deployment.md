# 用户中心部署

当前部署目标是本机主机 `10.1.11.200`，服务端口为 `17880`。用户中心只为统一管理模式在局域网提供账号登录，不承载采集数据或标注数据；离线模式不需要或连接该服务，客户端仍直接读取本机挂载的源卡。

## 一键安装

在当前主机的仓库目录执行：

```bash
pnpm user-center:install
```

要求主机安装 Node.js、pnpm、OpenSSL 和 macOS `security`/`launchctl`。脚本会：

1. 在 `~/Library/Application Support/DOHC User Center/` 创建服务数据目录和权限为 `0600` 的账号数据库。
2. 生成包含 `10.1.11.200` 与 `localhost` 的自签名 HTTPS 证书。
3. 注册 `com.dohc.viewer.user-center` LaunchAgent，开机启动并自动拉起服务。
4. 将客户端配置写到桌面 `DOHC-User-Center-Client.json`，并尝试把证书加入当前用户的登录钥匙串信任根。
5. 打开用户中心管理页 `https://localhost:17880/`。

`GET /healthz` 可从局域网检查服务状态。服务只暴露 `/api/v1/auth/login`、`/api/v1/auth/logout`、`/api/v1/auth/me` 和管理员账号 API；不存在客户端注册 API。服务重启后登录会话失效，客户端需要重新登录。

## 管理员初始化

首次初始化只能从服务主机本机完成。管理员设置首个管理员账号和密码后，进入账号管理页面创建操作员账号。不要通过修改 `users.json` 绕过页面，也不要把密码写入工单、日志、配置文件或 Git。

统一管理模式的操作员使用管理员提供的桌面配置文件导入客户端。配置文件包含服务 ID、固定 HTTPS 地址和证书公钥，不包含账号密码或采集数据。若客户端已经绑定其他服务，必须先由管理员确认设备归属；客户端不会自动切换用户中心。离线模式不会读取该配置或连接服务。

## 运维

服务日志位于用户中心数据目录的 `service.stdout.log` 和 `service.stderr.log`。账号数据库和私钥只应由主机管理员备份；备份前先停止服务并限制备份文件权限。停止服务：

```bash
launchctl bootout "gui/$(id -u)/com.dohc.viewer.user-center"
```

恢复服务：

```bash
pnpm user-center:install
```

这套服务不取代操作系统账号、磁盘加密或组织级 IAM。它只解决局域网内的统一登录和处理人归因。
