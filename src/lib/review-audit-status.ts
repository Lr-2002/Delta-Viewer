/** Queue facts for one service/account, never directory counts or inferred times. */
export interface ReviewSyncStatus {
  owner: string;
  pending: number | null;
  volatile: number;
  oldestVolatileAtMs: number | null;
  blocked: number;
  legacyInvalid: number;
  oldestPendingAtMs: number | null;
  lastSuccessAtMs: number | null;
  localError: string;
  uploadError: string;
  blockedError: string;
}

export function auditFailureReason(error: string): string {
  if (!error) return "原因未知";
  if (/INVALID_CREDENTIALS/i.test(error)) return "账号或密码不正确，请检查后重试";
  if (/AUTH_REQUIRED|REVIEWER_REQUIRED|AUTH_EXPIRED|TOKEN_EXPIRED|HTTP 401/i.test(error)) return "登录已失效，需要用当前账号重新登录";
  if (/timeout|timed out|超时/i.test(error)) return "请求超时，尚未收到用户中心确认";
  if (/HTTP 5\d\d|INTERNAL_SERVER_ERROR|SERVICE_UNAVAILABLE/i.test(error)) return "用户中心服务异常，稍后将自动重试";
  if (/certificate|证书|TLS/i.test(error)) return "用户中心证书或安全连接校验失败，请联系管理员检查配置";
  if (/REVIEW_EVENT_INVALID|AUDIT_TIME_INVALID/i.test(error)) return "服务端拒绝了操作记录，请联系管理员检查记录格式或时间；原记录保留";
  if (/REVIEW_AUDIT_ACCOUNT_MISMATCH/i.test(error)) return "当前账号或用户中心与记录归属不一致，记录保留在原账号下";
  if (/ENOSPC|disk full|no space|quota|磁盘空间/i.test(error)) return "本机存储空间不足，请释放空间后重试";
  if (/EACCES|permission denied|权限不足/i.test(error)) return "本机存储权限不足，请检查应用数据目录权限";
  if (/USER_CENTER_UNAVAILABLE|offline|network|断网|连接中断/i.test(error)) return "连接用户中心失败，具体原因尚未确认，请检查网络和服务状态";
  return `原因未知（${error}）`;
}

export function auditNeedsLogin(error: string) {
  return /AUTH_REQUIRED|REVIEWER_REQUIRED|AUTH_EXPIRED|TOKEN_EXPIRED|HTTP 401/i.test(error);
}
