import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  XCircle,
} from "lucide-react";
import {
  batchCreateSupervisionAccounts,
  chooseDirectory,
  exportSupervisionReport,
  getReviewDashboard,
  isTauriRuntime,
  setSupervisionAccountStatus,
} from "../lib/backend";
import {
  reviewActionLabels,
  type ReviewDashboardData,
  type ReviewEvent,
} from "../lib/review-audit-types";
import type { UserIdentity } from "../types";
import "./review-supervision.css";

type View = "overview" | "events" | "sessions" | "accounts";
const tabs: [View, string][] = [
  ["overview", "审核总览"],
  ["events", "实时行为"],
  ["sessions", "审核记录"],
  ["accounts", "审核账号"],
];
const time = (value: number | null) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "--";
const duration = (value: number | null) =>
  value === null
    ? "--"
    : `${Math.floor(value / 60000)} 分 ${Math.round((value % 60000) / 1000)} 秒`;
const detailNames: Record<string, string> = {
  target: "控件",
  value: "内容",
  before: "修改前",
  after: "修改后",
  frameFrom: "起始帧",
  frameTo: "目标帧",
  mediaTimeMs: "视频位置(ms)",
  durationMs: "操作耗时(ms)",
  segmentIndex: "片段索引",
  startFrame: "开始帧",
  endFrame: "结束帧",
  revision: "修订",
  reason: "原因",
  labelId: "标签ID",
  sourceName: "机标来源",
};
function eventDetails(event: ReviewEvent) {
  return Object.entries(event.details)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${detailNames[key] ?? key}: ${value}`)
    .join("；");
}

export function SupervisionDashboard({
  currentUser,
  onLogout,
}: {
  currentUser: UserIdentity;
  onLogout: () => Promise<void>;
}) {
  const [view, setView] = useState<View>("overview");
  const [data, setData] = useState<ReviewDashboardData | null>(null);
  const [username, setUsername] = useState("");
  const [action, setAction] = useState("");
  const [date, setDate] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [before, setBefore] = useState("");
  const [previous, setPrevious] = useState<string[]>([]);
  const [live, setLive] = useState(true);
  const [refreshId, setRefreshId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<ReviewEvent | null>(null);
  const [account, setAccount] = useState({
    username: "",
    displayName: "",
    password: "",
  });
  const query = useMemo(
    () =>
      ({
        ...(username ? { username } : {}),
        ...(action ? { action } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(before
          ? { [view === "sessions" ? "sessionBefore" : "before"]: before }
          : {}),
        ...(date
          ? {
              fromMs: String(new Date(`${date}T00:00:00`).getTime()),
              toMs: String(new Date(`${date}T23:59:59.999`).getTime()),
            }
          : {}),
      }) as Record<string, string>,
    [username, action, sessionId, before, date, view],
  );
  const requestGeneration = useRef(0);
  useEffect(() => {
    const generation = ++requestGeneration.current;
    let active = true,
      inFlight = false;
    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      setLoading(true);
      try {
        const next = await getReviewDashboard(query);
        if (active && generation === requestGeneration.current) {
          setData(next);
          setError("");
        }
      } catch (reason) {
        if (active) setError(String(reason));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    }
    void refresh();
    const timer =
      live && !before
        ? window.setInterval(() => {
            void refresh();
          }, 3000)
        : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [query, live, refreshId, before]);
  useEffect(() => {
    setBefore("");
    setPrevious([]);
    setSelected(null);
  }, [username, action, date, sessionId, view]);
  useEffect(() => {
    if (!selected) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = document.querySelector<HTMLButtonElement>(
      '[aria-label="关闭明细"]',
    );
    close?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if (event.key === "Tab") {
        event.preventDefault();
        close?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previousFocus?.focus();
    };
  }, [selected]);
  const users = (data?.users ?? []).filter(
    (user) => !username || user.username === username,
  );
  const totals = users.reduce(
    (total, user) => ({
      approved: total.approved + user.approved,
      rejected: total.rejected + user.rejected,
      operations: total.operations + user.operations,
      online: total.online + Number(user.online),
    }),
    { approved: 0, rejected: 0, operations: 0, online: 0 },
  );
  async function exportEvents() {
    setBusy("export");
    setNotice("");
    try {
      const rows: ReviewEvent[] = [];
      const filter = { ...query };
      delete filter.before;
      delete filter.sessionBefore;
      let cursor: string | undefined;
      do {
        const page = await getReviewDashboard({
          ...filter,
          ...(cursor ? { before: cursor } : {}),
        });
        rows.push(...page.events);
        cursor = page.nextBefore ? String(page.nextBefore) : undefined;
        setNotice(`已读取 ${rows.length} 条审核事件`);
      } while (cursor);
      const cell = (value: unknown) => {
        const text = String(value ?? "");
        return `"${(/^[\s]*[=+@-]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
      };
      const content =
        "\uFEFF" +
        [
          [
            "账号",
            "姓名",
            "数据",
            "审核会话",
            "操作",
            "发生时间",
            "收到时间",
            "距加载(ms)",
            "明细",
          ],
          ...rows.map((row) => [
            row.username,
            row.displayName,
            row.episodeName,
            row.sessionId,
            reviewActionLabels[row.action],
            time(row.occurredAtMs),
            time(row.receivedAtMs),
            row.elapsedMs,
            eventDetails(row),
          ]),
        ]
          .map((row) => row.map(cell).join(","))
          .join("\r\n");
      if (isTauriRuntime()) {
        const destination = await chooseDirectory("导出审核行为记录");
        if (!destination) return;
        const result = await exportSupervisionReport(
          destination,
          "daily",
          "csv",
          new Date().toISOString().slice(0, 10),
          Date.now(),
          content,
        );
        setNotice(`已导出 ${rows.length} 条事件：${result.outputPath}`);
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "review-events.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice(`已导出 ${rows.length} 条事件`);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy("account");
    setError("");
    try {
      await batchCreateSupervisionAccounts([account]);
      setAccount({ username: "", displayName: "", password: "" });
      setNotice("审核账号已创建");
      setRefreshId((id) => id + 1);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  async function setAccountStatus(name: string, status: "active" | "paused") {
    setBusy(name);
    try {
      await setSupervisionAccountStatus([name], status);
      setRefreshId((id) => id + 1);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy("");
    }
  }
  return (
    <main className="review-supervision">
      <header className="review-supervision-header">
        <div>
          <ShieldCheck size={25} />
          <h1>审核监管</h1>
        </div>
        <div>
          <span>
            {currentUser.displayName} · @{currentUser.username}
          </span>
          <button
            className="icon-button"
            title="退出登录"
            aria-label="退出登录"
            onClick={() => void onLogout()}
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <nav aria-label="审核监管视图">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={view === id ? "active" : ""}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="review-supervision-filters">
        <label>
          审核账号
          <select
            aria-label="审核账号筛选"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          >
            <option value="">全部账号</option>
            {data?.users.map((user) => (
              <option key={user.username} value={user.username}>
                {user.displayName} (@{user.username})
              </option>
            ))}
          </select>
        </label>
        <label>
          日期
          <input
            aria-label="审核日期"
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          操作
          <select
            aria-label="操作筛选"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">全部操作</option>
            {Object.entries(reviewActionLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {sessionId && (
          <button
            className="button button-secondary"
            onClick={() => setSessionId("")}
          >
            <XCircle size={15} />
            清除条目筛选
          </button>
        )}
        <div className="review-supervision-sync">
          <span className={error ? "sync-error" : ""}>
            {error
              ? "同步失败"
              : loading
                ? "同步中"
                : `更新于 ${time(data?.generatedAtMs ?? null)}`}
          </span>
          <button
            className="icon-button"
            aria-label={live ? "暂停实时刷新" : "恢复实时刷新"}
            title={live ? "暂停实时刷新" : "恢复实时刷新"}
            onClick={() => {
              setLive(!live);
              setBefore("");
              setPrevious([]);
            }}
          >
            {live ? <Pause size={17} /> : <Play size={17} />}
          </button>
          <button
            className="icon-button"
            title="刷新"
            aria-label="刷新"
            onClick={() => setRefreshId((id) => id + 1)}
            disabled={loading}
          >
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
        <button
          className="button button-secondary"
          disabled={Boolean(busy)}
          aria-label="导出审核事件"
          title="导出审核事件"
          onClick={() => void exportEvents()}
        >
          {busy === "export" ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Download size={16} />
          )}
          导出审核事件
        </button>
      </div>
      {error && (
        <p role="alert" className="review-audit-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {view === "overview" && (
        <>
          <section className="review-kpis">
            <div>
              <Activity />
              <span>
                在线审核员<strong>{totals.online}</strong>
              </span>
            </div>
            <div>
              <CheckCircle2 />
              <span>
                通过操作<strong>{totals.approved}</strong>
              </span>
            </div>
            <div>
              <XCircle />
              <span>
                不通过操作<strong>{totals.rejected}</strong>
              </span>
            </div>
            <div>
              <Activity />
              <span>
                交互操作<strong>{totals.operations}</strong>
              </span>
            </div>
          </section>
          <h2>账号审核进度</h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>审核账号</th>
                  <th>状态</th>
                  <th>通过 / 不通过</th>
                  <th>平均加载至提交</th>
                  <th>视频定位</th>
                  <th>标签新增 / 删除</th>
                  <th>最近操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.username}>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => {
                          setUsername(user.username);
                          setView("events");
                        }}
                      >
                        {user.displayName}
                        <small>@{user.username}</small>
                      </button>
                    </td>
                    <td>
                      <span className={user.online ? "review-online" : ""}>
                        {user.online ? "在线" : "离线"}
                      </span>
                    </td>
                    <td>
                      {user.approved} / {user.rejected}
                    </td>
                    <td>{duration(user.averageMs)}</td>
                    <td>{user.seeks}</td>
                    <td>
                      {user.labelsAdded} / {user.labelsDeleted}
                    </td>
                    <td>{time(user.lastActivityAtMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view === "events" && (
        <>
          <h2>
            交互时间线 <small>{data?.total ?? 0} 条</small>
          </h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>发生时间</th>
                  <th>审核账号</th>
                  <th>数据条目</th>
                  <th>操作</th>
                  <th>距加载</th>
                  <th>操作明细</th>
                </tr>
              </thead>
              <tbody>
                {data?.events.map((event) => (
                  <tr key={event.id}>
                    <td>{time(event.occurredAtMs)}</td>
                    <td>
                      {event.displayName}
                      <small>@{event.username}</small>
                    </td>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => setSessionId(event.sessionId)}
                      >
                        {event.episodeName}
                      </button>
                    </td>
                    <td>{reviewActionLabels[event.action]}</td>
                    <td>{duration(event.elapsedMs)}</td>
                    <td>
                      <button
                        className="review-event-detail"
                        onClick={() => setSelected(event)}
                      >
                        {eventDetails(event) || "查看记录"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="review-pagination">
            <button
              className="icon-button"
              title="上一页"
              aria-label="上一页"
              disabled={!previous.length}
              onClick={() => {
                setBefore(previous.at(-1)!);
                setPrevious(previous.slice(0, -1));
              }}
            >
              <ChevronLeft size={18} />
            </button>
            <span>{previous.length + 1}</span>
            <button
              className="icon-button"
              title="更早记录"
              aria-label="更早记录"
              disabled={!data?.nextBefore}
              onClick={() => {
                setPrevious([...previous, before]);
                setBefore(String(data!.nextBefore));
              }}
            >
              <ChevronRight size={18} />
            </button>
          </footer>
        </>
      )}
      {view === "sessions" && (
        <>
          <h2>逐条审核记录</h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>数据条目</th>
                  <th>账号</th>
                  <th>载入时间</th>
                  <th>最近操作</th>
                  <th>结论</th>
                  <th>加载至提交</th>
                  <th>交互次数</th>
                </tr>
              </thead>
              <tbody>
                {data?.sessions.map((row) => (
                  <tr key={`${row.username}:${row.sessionId}`}>
                    <td>
                      <button
                        className="review-user-link"
                        onClick={() => {
                          setSessionId(row.sessionId);
                          setView("events");
                        }}
                      >
                        {row.episodeName}
                      </button>
                    </td>
                    <td>@{row.username}</td>
                    <td>{time(row.loadedAtMs)}</td>
                    <td>{time(row.lastActivityAtMs)}</td>
                    <td>
                      {row.status === "approved"
                        ? "通过"
                        : row.status === "rejected"
                          ? "不通过"
                          : "待审核"}
                    </td>
                    <td>{duration(row.durationMs)}</td>
                    <td>{row.operations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {view === "sessions" && (
        <footer className="review-pagination">
          <button
            className="icon-button"
            aria-label="上一页审核记录"
            title="上一页审核记录"
            disabled={!previous.length}
            onClick={() => {
              setBefore(previous.at(-1)!);
              setPrevious(previous.slice(0, -1));
            }}
          >
            <ChevronLeft size={18} />
          </button>
          <span>{previous.length + 1}</span>
          <button
            className="icon-button"
            aria-label="更早审核记录"
            title="更早审核记录"
            disabled={!data?.nextSessionBefore}
            onClick={() => {
              setPrevious([...previous, before]);
              setBefore(String(data!.nextSessionBefore));
            }}
          >
            <ChevronRight size={18} />
          </button>
        </footer>
      )}
      {view === "accounts" && (
        <>
          <h2>审核账号</h2>
          <div className="review-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>姓名</th>
                  <th>状态</th>
                  <th>账号管理</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.username}>
                    <td>@{user.username}</td>
                    <td>{user.displayName}</td>
                    <td>{user.accountStatus === "active" ? "启用" : "暂停"}</td>
                    <td>
                      <button
                        className="button button-secondary"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void setAccountStatus(
                            user.username,
                            user.accountStatus === "active"
                              ? "paused"
                              : "active",
                          )
                        }
                      >
                        {user.accountStatus === "active" ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {user.accountStatus === "active"
                          ? "暂停账号"
                          : "启用账号"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            className="review-account-form"
            onSubmit={(event) => void createAccount(event)}
          >
            <h2>新建审核账号</h2>
            <label>
              账号
              <input
                required
                minLength={3}
                maxLength={32}
                autoComplete="off"
                value={account.username}
                onChange={(event) =>
                  setAccount({ ...account, username: event.target.value })
                }
              />
            </label>
            <label>
              姓名
              <input
                required
                maxLength={40}
                value={account.displayName}
                onChange={(event) =>
                  setAccount({ ...account, displayName: event.target.value })
                }
              />
            </label>
            <label>
              初始密码
              <input
                required
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={account.password}
                onChange={(event) =>
                  setAccount({ ...account, password: event.target.value })
                }
              />
            </label>
            <button className="button button-primary" disabled={Boolean(busy)}>
              <UserPlus size={16} />
              创建账号
            </button>
          </form>
        </>
      )}
      {!loading && !data?.events.length && view !== "accounts" && (
        <p className="review-empty">暂无符合条件的审核操作</p>
      )}
      {selected && (
        <div
          className="review-dialog-backdrop"
          onClick={() => setSelected(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="审核操作明细"
            className="review-detail-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{reviewActionLabels[selected.action]}</h2>
              <button
                className="icon-button"
                title="关闭明细"
                aria-label="关闭明细"
                onClick={() => setSelected(null)}
              >
                <XCircle size={18} />
              </button>
            </header>
            <p>
              {selected.displayName} (@{selected.username}) ·{" "}
              {selected.episodeName}
            </p>
            <dl>
              <dt>发生时间</dt>
              <dd>{time(selected.occurredAtMs)}</dd>
              <dt>接收时间</dt>
              <dd>{time(selected.receivedAtMs)}</dd>
              <dt>事件 ID</dt>
              <dd>{selected.eventId}</dd>
              {Object.entries(selected.details).map(([key, value]) => (
                <div key={key}>
                  <dt>{detailNames[key] ?? key}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      )}
    </main>
  );
}
