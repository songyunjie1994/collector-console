"use strict";
/**
 * 采集管理台（网页版）脚本。
 *
 * 界面按旧版采集中心的习惯组织：每套工具一张卡片，卡片上直接设定时；下面是「运行动态」。
 * 这里只负责数据与交互。
 *
 * 安全约定（这条最重要）：
 *   - 这个文件里**没有任何密钥**。没有 service role、没有管理密钥、没有 GitHub 令牌。
 *     只有 Supabase 的公开配置（URL + publishable key），它们本来就是设计成公开的。
 *   - 权限全在服务端：每次调用都带用户自己的登录令牌，服务端校验身份 + 邮箱白名单。
 *   - 不引任何外部脚本/CDN：登录直接调 Supabase 的 auth REST 接口。
 */

const CONFIG = Object.freeze({
  supabaseUrl: "https://mabxdkjqilulkrmqrrgo.supabase.co",
  publishableKey: "sb_publishable_lfHpd1y1gCaQIDXfRkD_8w_O1bPMWGx",
  // 页面托管在 GitHub Pages，接口在 Supabase 函数上 —— 是跨域调用。
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/collector-admin/api"
});

const SESSION_KEY = "qca-console-session";
const state = { session: null, sessionEpoch: 0, agents: [], selectedAgentId: null, auto: null, runs: [], progressUpdatedAt: null, progressError: null };

// 工具显示名：优先用设备上报的名字，没有就用这张表兜底；表里没有就直接显示 id。
const TOOL_NAMES = {
  "liyang-tina": "李杨 tina",
  "liyang-tes": "李杨 tes",
  "huihe": "惠和",
  "yujianweilai-1": "域见未来 1",
  "tool5": "李杨赫丝"
};
// 卡片头像配色，按顺序循环，跟旧版一样每张卡片一个色
const ACCENTS = ["accent-violet", "accent-blue", "accent-green", "accent-orange", "accent-violet"];

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toolLabel(id) {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const fromDevice = (agent?.status?.toolNames || []).find((row) => row.id === id);
  return fromDevice?.name || TOOL_NAMES[id] || id;
}
function deviceTools() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const tools = agent?.status?.tools;
  return Array.isArray(tools) ? tools : [];
}
function lastRunFor(toolId) {
  const matches = state.runs.flatMap((row) => {
    if (row.tool_id === toolId) return [row];
    if (row.tool_id !== "*") return [];
    const tool = Array.isArray(row.summary?.tools) ? row.summary.tools.find((item) => item?.id === toolId) : null;
    return tool ? [{ ...row, tool_id: toolId, status: tool.status, toolResult: tool }] : [];
  });
  const time = (row) => Date.parse(row.finished_at || row.started_at || row.planned_for || "") || 0;
  return matches.sort((a, b) => time(b) - time(a))[0] || null;
}
function displayTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? new Date(time).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }) : "未知";
}
function deviceAuto() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  return agent?.status?.auto || null;
}

// ---------- 采集进度（设备多上报的那几个字段）----------
// 老版本 Agent 只上报 7 个字段，这些会是空的；页面自动降级，不报错。
function deviceStatus() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  return agent?.status || null;
}
function deviceClients() {
  const list = deviceStatus()?.clients;
  return Array.isArray(list) ? list : [];
}
function deviceJob() {
  const job = deviceStatus()?.job;
  return job && typeof job === "object" ? job : null;
}
function deviceQueue() {
  const queue = deviceStatus()?.queue;
  return queue && typeof queue === "object" ? queue : null;
}
function clientStateOf(toolId) {
  return deviceClients().find((row) => row.id === toolId) || null;
}
/** 工具实时状态 → 中文标签 + 颜色。键与 src/unified-maintenance.js 的 BUSY_STATES 对齐。 */
const CLIENT_STATE_LABEL = {
  idle: ["空闲", "wait"],
  running: ["采集中", "busy"],
  discovering: ["读取账户", "busy"],
  saving: ["保存数据", "busy"],
  exporting: ["导出报表", "busy"],
  syncing: ["同步云端", "busy"],
  sync_pending: ["采完·回传待重试", "wait"],
  sync_superseded: ["旧回传已阻止", "wait"],
  cloud_sync_network: ["回传网络失败", "off"],
  cloud_sync_http: ["回传接口失败", "off"],
  opening_login: ["打开登录", "wait"],
  success: ["成功", "on"],
  partial_success: ["部分成功", "wait"],
  failed: ["失败", "off"],
  step_failed: ["步骤失败", "off"],
  login_required: ["需登录", "off"],
  cloud_conflict: ["云端冲突", "off"],
  error: ["异常", "off"]
};
function clientStatePill(row) {
  const [label, cls] = CLIENT_STATE_LABEL[row?.state] || [row?.state || "—", "wait"];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}
function elapsedText(startedAt) {
  const at = Date.parse(startedAt || "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "刚开始";
  if (minutes < 60) return `已用时 ${minutes} 分钟`;
  return `已用时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
/** 只显示设备实际调度，不推算正在运行任务的完成时间。 */
function nextRunText() {
  const info = deviceAuto();
  if (!info) return "下次自动采集：等待设备上报";
  if (info.enabled === false) return "下次自动采集：未开启";
  if (deviceStatus()?.job?.running && deviceStatus().job.mode === "scheduled") {
    const hours = Number(info.intervalHours);
    return `本轮正在采集；${hours > 0 ? `结束后间隔 ${hours} 小时再采` : "下次时间等待设备上报"}`;
  }
  if (!info.nextRunAt) return "下次自动采集：等待设备上报";
  const when = Date.parse(info.nextRunAt);
  if (!Number.isFinite(when)) return "下次自动采集：设备上报时间无效";
  const deltaMin = Math.round((when - Date.now()) / 60000);
  const clock = displayTime(info.nextRunAt);
  const rel = deltaMin <= 0 ? "（已到点，等采集空闲）" : deltaMin < 60 ? `（约 ${deltaMin} 分钟后）` : `（约 ${Math.round(deltaMin / 60)} 小时后）`;
  return `下次自动采集：${clock}（北京时间）${rel}`;
}

function toast(message, kind = "info") {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`;
  setTimeout(() => node.classList.add("hidden"), 4800);
}

/**
 * 会话持久化。
 *
 * 用 localStorage，**不是 sessionStorage** —— 后者一关标签页就清空，
 * 那正是"每次打开都要重新输密码"的头号原因。
 */
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(value) {
  if (!value) state.sessionEpoch += 1;
  try {
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* 隐私模式下 localStorage 可能不可用，忽略即可 */ }
}

// ---------------- 登录 / 令牌续期 ----------------

async function signIn(email, password) {
  const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const raw = body.error_description || body.msg || "";
    const message = /invalid login credentials/i.test(raw) ? "邮箱或密码不对"
      : /email not confirmed/i.test(raw) ? "这个邮箱还没确认（需要在 Supabase 里勾 Auto Confirm）"
        : raw || `登录失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  const body = await response.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    email,
    // 记下过期时刻，好在到期前主动续期（服务端默认 1 小时）
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
  };
}

/**
 * 用 refresh token 换新的访问令牌。
 *
 * 以前没有这一步：access token 一过期（默认 1 小时）接口就返回 401，
 * 于是被踢回登录页 —— 这就是"过一会儿又要重新输密码"的原因。
 * 服务端若开了 refresh token 轮换，会返回新的 refresh token，必须存下来。
 */
let refreshing = null;   // 并发去重：多个请求同时发现过期时只刷新一次
async function refreshSession() {
  const session = state.session;
  if (!session?.refreshToken) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey },
        body: JSON.stringify({ refresh_token: session.refreshToken })
      });
      if (!response.ok) return null;
      const body = await response.json();
      const next = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || session.refreshToken,
        email: session.email || body.user?.email || "",
        expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
      };
      state.session = next;
      saveSession(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** 快到期就先续期（提前 2 分钟），避免请求打在过期的令牌上 */
async function ensureFreshToken() {
  const session = state.session;
  if (!session?.accessToken) return null;
  const expiresAt = Number(session.expiresAt || 0);
  if (!expiresAt) return session;                       // 老会话没记过期时间：等 401 再续
  if (Date.now() < expiresAt - 120000) return session;  // 还早，不动
  return (await refreshSession()) || session;
}

async function api(action, payload = {}) {
  if (!state.session) throw new Error("还没登录");

  const call = async (token) => {
    const response = await fetch(CONFIG.apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload })
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };

  await ensureFreshToken();
  let { response, body } = await call(state.session.accessToken);

  // 401 也可能是"令牌恰好在这一刻过期"：先续期重试一次，再决定要不要把用户请回登录页
  if (response.status === 401) {
    const renewed = await refreshSession();
    if (renewed) ({ response, body } = await call(renewed.accessToken));
  }

  if (!response.ok) {
    if (response.status === 401) { saveSession(null); state.session = null; showLogin(); }
    const error = new Error(body.message || body.error || `接口返回 ${response.status}`);
    error.conflict = body.conflict === true;
    throw error;
  }
  return body;
}

/** 改密码：调 Supabase 的"更新当前用户"接口，带自己的访问令牌（服务端校验，页面不碰密钥） */
async function changePassword() {
  const first = $("#newPassword").value;
  const second = $("#newPassword2").value;
  const error = $("#passwordError");
  error.textContent = "";
  if (first.length < 8) { error.textContent = "新密码至少 8 位"; return; }
  if (first !== second) { error.textContent = "两次输入不一致"; return; }
  const button = $("#passwordSave");
  button.disabled = true;
  try {
    await ensureFreshToken();   // 改密码也要用没过期的令牌
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/user`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.publishableKey,
        Authorization: `Bearer ${state.session.accessToken}`
      },
      body: JSON.stringify({ password: first })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.msg || body.error_description || `改密码失败（HTTP ${response.status}）`);
    }
    $("#passwordModal").classList.add("hidden");
    $("#newPassword").value = "";
    $("#newPassword2").value = "";
    saveSession(null);
    state.session = null;
    showLogin();
    toast("密码已改，请用新密码重新登录", "ok");
  } catch (e) {
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

// ---------------- 渲染 ----------------

function showLogin() {
  $("#loginView").classList.remove("hidden");
  $("#mainView").classList.add("hidden");
}
function showMain() {
  $("#loginView").classList.add("hidden");
  $("#mainView").classList.remove("hidden");
  $("#whoami").textContent = state.session?.email || "";
  startAutoRefresh();
}

/**
 * 页面开着时每 20 秒自动拉一次（与采集机心跳同频）——"实时进度"要真的实时。
 * 页面切到后台时跳过，不白占服务端。
 */
let autoRefreshTimer = null;
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (document.hidden || !state.session || !state.selectedAgentId) return;
    loadProgress().catch(() => { /* loadProgress 已明确显示刷新失败，不隐瞒旧快照 */ });
  }, 20000);
}

function onlineState(agent) {
  if (!agent.last_seen_at) return { label: "从未上线", cls: "off" };
  const ageMs = Date.now() - Date.parse(agent.last_seen_at);
  if (ageMs > 90 * 1000) return { label: `离线（${Math.round(ageMs / 60000)} 分钟没心跳）`, cls: "off" };
  if (agent.status?.draining) return { label: "正在等采集跑完", cls: "busy" };
  if (agent.status?.jobRunning) return { label: "正在采集", cls: "busy" };
  return { label: "在线", cls: "on" };
}

function renderAgents() {
  const select = $("#agentSelect");
  if (select) {
    select.innerHTML = state.agents.map((agent) =>
      `<option value="${esc(agent.id)}" ${agent.id === state.selectedAgentId ? "selected" : ""}>${esc(agent.status?.host || agent.name || agent.id)}（${esc(agent.id)}）</option>`
    ).join("") || '<option value="">（还没有采集机接入）</option>';
  }
  const online = $("#agentOnline");
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (online && agent) {
    const s = onlineState(agent);
    online.querySelector("span").textContent = `${s.label} · ${controlState(agent)}`;
    online.className = `inline-status ${s.cls}`;
  }
  renderOverview();
}

function controlState(agent) {
  if (onlineState(agent).cls === "off") return "远程控制不可用，当前显示为最后快照";
  const control = agent.status?.control;
  if (!control?.task || !control?.guard) return "独立守护尚未验证";
  const checked = Date.parse(control.guard.checkedAt || "");
  if (!Number.isFinite(checked) || Date.now() - checked > 180000) return "独立守护巡检过期";
  if (control.guard.action === "blocked" || /invalid-code|legacy-agent/.test(control.guard.reason || "")) return "远程已连接，守护需修复";
  return "远程已连接 · 独立守护正常";
}

/** 顶部概览：跟旧版一样，一眼看到总数、失败数与当前状态 */
function renderOverview() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const online = agent ? onlineState(agent) : null;
  const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  set("#toolCount", agent ? (agent.status?.toolCount ?? deviceTools().length) : "—");

  const outcomes = deviceJob()?.results;
  set("#failCount", Array.isArray(outcomes) ? outcomes.filter((row) => row.status === "failed").length : "—");
  const status = $("#jobStatus");
  const text = $("#jobStatusText");
  if (status && text) {
    const busy = online?.cls !== "off" && (Boolean(agent?.status?.jobRunning) || Boolean(agent?.status?.draining));
    status.classList.toggle("active", Boolean(agent) && online?.cls !== "off" && !busy);
    status.classList.toggle("busy", Boolean(busy));
    text.textContent = !agent ? "等待数据"
      : busy ? (agent.status?.draining ? "正在收尾（等采集跑完）" : "正在采集")
        : online.cls === "off" ? "采集机离线" : "当前空闲";
  }
}

function runStatusPill(status) {
  const map = {
    success: ["成功", "on"], partial: ["部分成功", "wait"], partial_success: ["部分成功", "wait"], failed: ["失败", "off"],
    skipped: ["已跳过", "wait"], running: ["执行中", "busy"]
  };
  const [label, cls] = map[status] || [status || "—", "wait"];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

/** 工具卡片：每套工具一张，卡片上直接设定时（跟旧版"客户采集工具"一样的位置） */
/** 顶部自动采集控制条：和旧版一样，一个开关 + 间隔 */
function renderAutoControls() {
  const enabled = $("#autoEnabled");
  const hours = $("#autoHours");
  const status = $("#autoStatus");
  const save = $("#saveAuto");
  if (!enabled || !hours || !status) return;
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const cloud = agent ? (state.schedules?.auto || null) : null;   // 来自 get_auto 的云端保存值
  const device = deviceAuto();                                     // 设备实际应用值
  const hasAgent = Boolean(agent);
  enabled.disabled = !hasAgent;
  hours.disabled = !hasAgent;
  if (save) save.disabled = !hasAgent;
  if (!hasAgent) { renderAutoStatus(); return; }

  const savedOn = cloud?.enabled === true;
  const savedHours = Number(cloud?.interval_hours || 6);
  if (document.activeElement !== enabled) enabled.checked = savedOn;
  if (document.activeElement !== hours) hours.value = String(savedHours);

  renderAutoStatus();
}

// 心跳刷新只更新只读状态，不覆盖尚未保存的间隔或开关。
function renderAutoStatus() {
  const status = $("#autoStatus");
  const next = $("#nextAutoRun");
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (next) next.textContent = agent ? nextRunText() : "下次自动采集：未选择采集机";
  if (!status) return;
  if (!agent) { status.textContent = "未选择采集机"; return; }
  const cloud = state.schedules?.auto;
  const savedOn = cloud?.enabled === true;
  const savedHours = Number(cloud?.interval_hours || 6);

  const savedVersion = Number(cloud?.config_version || 0);
  const appliedVersion = Number(cloud?.applied_version || 0);
  const parts = [];
  if (!savedVersion) parts.push("云端还没设置过");
  else if (appliedVersion >= savedVersion) parts.push(`设备已应用 v${appliedVersion}`);
  else parts.push(`云端已保存 v${savedVersion}，待设备应用`);
  parts.push(savedOn ? `每 ${savedHours} 小时跑全部工具` : "当前未开启");
  parts.push("自动采集最近 3 天");
  status.textContent = parts.filter(Boolean).join(" · ");
}

/**
 * 实时进度：正在采哪个工具、第几个、每套工具此刻在做什么、云端任务积压多少。
 * 这些字段是 Agent 新增上报的（clients / job / queue）；老版本不上报时明确说明，不假装正常。
 */
function renderProgress() {
  const box = $("#progressPanel");
  if (!box) return;
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (!agent) {
    box.innerHTML = '<div class="pad muted">还没有采集机接入。</div>';
    return;
  }
  if (onlineState(agent).cls === "off") {
    box.innerHTML = `<div class="pad muted">远程控制通道已断开。最后心跳：${esc(agent.last_seen_at || "从未上线")}。<br>采集状态为历史快照，不能据此判断当前是否正常；恢复连接后自动刷新。</div>`;
    return;
  }
  const clients = deviceClients();
  const job = deviceJob();
  const queue = deviceQueue();

  if (!clients.length && !job) {
    box.innerHTML = `<div class="pad muted">
      这台采集机的程序<b>还没有上报进度明细</b>（当前版本 ${esc(deviceStatus()?.version || "未知")}）。<br>
      <span class="small">进度明细需要采集机程序 ≥ 1.4.0；旧版本只能看到「在采 / 没在采」。</span>
    </div>`;
    return;
  }

  const rows = clients.length
    ? clients
    : deviceTools().map((id) => ({ id, name: toolLabel(id), state: "idle", message: "" }));

  const total = Number(job?.total) || rows.length;
  const done = Number(job?.done) || 0;
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const activeId = job?.activeClientId || null;
  const activeRow = activeId ? (rows.find((row) => row.id === activeId) || { id: activeId, name: toolLabel(activeId) }) : null;
  const elapsed = job?.startedAt ? elapsedText(job.startedAt) : "";
  const results = Array.isArray(job?.results) ? job.results : [];
  const count = (status) => results.filter((row) => row.status === status).length;
  const outcomes = `成功 ${count("success")} · 部分成功 ${count("partial_success")} · 失败 ${count("failed")} · 跳过 ${count("skipped")}`;

  const head = job?.running
    ? `<div class="progress-head">
         <span class="pill busy">正在采集</span>
         <strong>${esc(activeRow?.name || activeRow?.id || "—")}</strong>
         <span class="muted">第 ${Math.min(done + 1, total)}/${total} 个${elapsed ? ` · ${esc(elapsed)}` : ""}</span>
       </div>`
    : `<div class="progress-head"><span class="pill ${count("failed") ? "wait" : "on"}">空闲</span><span class="muted">当前没有采集任务在跑${results.length ? ` · 上轮已结束（${esc(outcomes)}）` : ""}</span></div>`;

  const bar = `<div class="progress-bar"><i style="width:${percent}%"></i><span>已处理 ${done}/${total}（不是成功率）</span></div>`;
  const freshness = `<div class="progress-queue">设备心跳：${esc(displayTime(agent.last_seen_at))} · 网页刷新：${esc(displayTime(state.progressUpdatedAt))}${
    state.progressError ? ` · <span class="pill off">刷新失败，当前显示旧快照：${esc(state.progressError)}</span>` : ""
  }${job?.running && results.length ? `<br>本轮已处理结果：${esc(outcomes)}` : ""}</div>`;

  const pending = Number(queue?.pending) || 0;
  const executing = Number(queue?.executing) || 0;
  const queueLine = queue
    ? `<div class="progress-queue">云端任务队列：待执行 <b>${pending}</b> · 执行中 <b>${executing}</b> · 待回传 <b>${Number(queue.unreported) || 0}</b>${
      pending + executing > 1 ? ' <span class="pill wait">有积压</span>' : ""}</div>`
    : "";

  const list = rows.map((row) => `<div class="progress-client">
      <span class="pc-name">${esc(row.name || toolLabel(row.id))}</span>
      ${clientStatePill(row)}
      <span class="pc-msg muted">${esc(row.message || "")}</span>
    </div>`).join("");

  box.innerHTML = head + bar + freshness + queueLine + `<div class="progress-clients">${list}</div>`;
}

function renderTools() {
  renderProgress();
  const grid = $("#toolGrid");
  if (!grid) return;
  const tools = deviceTools();
  if (!state.selectedAgentId) {
    grid.innerHTML = '<div class="panel pad muted">还没有采集机接入。在采集机上双击安装包会自动登记。</div>';
    renderOverview();
    return;
  }
  if (!tools.length) {
    grid.innerHTML = '<div class="panel pad muted">这台采集机还没上报工具清单（它可能刚上线或程序没在运行）。</div>';
    renderOverview();
    return;
  }
  grid.innerHTML = tools.map((toolId, index) => {
    const lastRun = lastRunFor(toolId);
    const live = clientStateOf(toolId);
    const accent = ACCENTS[index % ACCENTS.length];
    const lastText = !lastRun ? "还没有执行记录"
      : `${lastRun.finished_at ? "完成" : "启动"} ${esc(displayTime(lastRun.finished_at || lastRun.started_at || lastRun.planned_for))} ${runStatusPill(lastRun.status)}`;
    const auto = deviceAuto();
    const on = auto?.enabled === true;
    const statusPill = on ? '<span class="pill on">自动采集已开</span>' : '<span class="pill off">自动采集未开</span>';
    return `<article class="client-card ${accent}">
      <span class="card-order">${index + 1}</span>
      <div class="client-head">
        <div class="client-avatar">${esc(toolLabel(toolId).slice(0, 1))}</div>
        <div class="client-title">
          <h3>${esc(toolLabel(toolId))}</h3>
          <span>${esc(toolId)}</span>
        </div>
        ${statusPill}
      </div>
      <div class="tool-live">当前：${live ? `${clientStatePill(live)} <span class="muted">${esc(live.message || "")}</span>` : '<span class="pill wait">未上报</span>'}</div>
      ${live?.syncRecovery ? `<div class="tool-sync muted">回传待重试 ${esc(live.syncRecovery.pending)}；需核验 ${esc(live.syncRecovery.blocked)}${live.syncRecovery.nextAttemptAt ? `；下次回传重试 ${esc(displayTime(live.syncRecovery.nextAttemptAt))}` : ""}${live.syncRecovery.lastVerifiedAt ? `；最近回传核验 ${esc(displayTime(live.syncRecovery.lastVerifiedAt))}` : ""}</div>` : ""}
      <div class="tool-last">最近一次：${lastText}</div>
    </article>`;
  }).join("");
  renderOverview();
}

/** 去掉日志里的 ANSI 转义码：Playwright 的 Call log 会带 [2m / [22m 之类，直接显示很难看 */
function cleanLogText(text) {
  return String(text || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\[\d+m/g, "")
    .replace(/\s+\n/g, "\n")
    .trim();
}

/** log_tail 是「工具名：原因；工具名：原因」拼起来的，拆开好按工具对齐 */
function splitRunReasons(logTail) {
  const text = cleanLogText(logTail);
  if (!text) return [];
  return text.split("；").map((row) => row.trim()).filter(Boolean);
}

/** 本轮用时（起止都在时才算） */
function runDurationText(run) {
  const start = Date.parse(run.started_at || "");
  const end = Date.parse(run.finished_at || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const minutes = Math.max(1, Math.round((end - start) / 60000));
  return minutes >= 60 ? `用时 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `用时 ${minutes} 分钟`;
}

const TOOL_STATE_META = {
  success: { icon: "✅", label: "成功" },
  partial_success: { icon: "⚠️", label: "部分成功" },
  failed: { icon: "❌", label: "失败" },
  skipped: { icon: "⏭", label: "已跳过" },
  no_data: { icon: "➖", label: "无数据" }
};

/** 运行动态：一条记录 = 一轮；展开能看到**每个工具**的状态与原因，而不是一坨 JSON */
function renderRuns() {
  const list = $("#activityList");
  if (!list) return;
  if (!state.runs.length) {
    list.innerHTML = '<div class="empty-activity">还没有执行记录</div>';
    renderOverview();
    return;
  }
  const trigger = { schedule: "按定时", catchup: "补跑", manual: "手动" };

  list.innerHTML = state.runs.map((run) => {
    const summary = run.summary && typeof run.summary === "object" ? run.summary : {};
    const tools = Array.isArray(summary.tools) ? summary.tools : [];
    const reasons = splitRunReasons(run.log_tail);

    // 把「工具名：原因」按工具名对上，方便挂在对应那一行
    const reasonByTool = new Map();
    for (const row of reasons) {
      const cut = row.indexOf("：");
      if (cut > 0) reasonByTool.set(row.slice(0, cut).trim(), row.slice(cut + 1).trim());
    }

    // 统计摘要：成功/失败/跳过 + 共同步了多少条（条数要 Agent 上报，没有就不显示）
    const counts = [];
    if (Number.isFinite(summary.ok)) counts.push(`成功 ${summary.ok}`);
    if (Number.isFinite(summary.partial) && summary.partial > 0) counts.push(`其中部分成功 ${summary.partial}`);
    if (Number.isFinite(summary.failed) && summary.failed > 0) counts.push(`失败 ${summary.failed}`);
    if (Number.isFinite(summary.skipped) && summary.skipped > 0) counts.push(`跳过 ${summary.skipped}`);
    const totals = summary.totals;
    if (totals && Number.isFinite(totals.records) && Number.isFinite(totals.finance)) {
      counts.push(`同步消耗 ${totals.records || 0} 条 / 财务 ${totals.finance || 0} 条`);
    }

    const detail = tools.length
      ? tools.map((tool) => {
        const meta = TOOL_STATE_META[tool.status] || { icon: "•", label: tool.status || "未知" };
        const text = tool.message
          || reasonByTool.get(tool.name)
          || (tool.status === "skipped" ? "已按请求停止，跳过该工具" : "");
        return `<div class="run-tool">
            <span class="rt-icon">${meta.icon}</span>
            <span class="rt-name">${esc(tool.name || tool.id || "")}</span>
            <span class="rt-state st-${esc(tool.status || "unknown")}">${esc(meta.label)}</span>
            <span class="rt-detail">${esc(text)}</span>
          </div>`;
      }).join("")
      : `<div class="run-tool"><span class="rt-icon">•</span><span class="rt-detail">${esc(reasons[0] || "（没有逐工具明细）")}</span></div>`;

    const fullLog = cleanLogText(run.log_tail) || "（没有日志）";
    return `<div class="activity-item">
      <div class="activity-head">
        <span class="activity-time">${esc(displayTime(run.started_at || run.planned_for))}</span>
        <span class="activity-tool">${esc(run.tool_name || toolLabel(run.tool_id))}</span>
        ${runStatusPill(run.status)}
        <span class="activity-text">${esc(trigger[run.trigger] || run.trigger || "")}${runDurationText(run) ? " · " + esc(runDurationText(run)) : ""}${counts.length ? " · " + esc(counts.join(" · ")) : ""}</span>
        <button class="text-button" data-log="${esc(run.id)}">日志</button>
      </div>
      <div class="run-tools">${detail}</div>
      <pre class="log hidden" data-log-body="${esc(run.id)}">${esc(fullLog)}</pre>
    </div>`;
  }).join("");

  list.querySelectorAll("[data-log]").forEach((button) => {
    button.addEventListener("click", () => {
      const node = list.querySelector(`[data-log-body="${CSS.escape(button.dataset.log)}"]`);
      if (node) node.classList.toggle("hidden");
    });
  });
  renderOverview();
}

// ---------------- 行为 ----------------

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  state.runs = [];
  state.progressUpdatedAt = null;
  state.progressError = null;
  renderAgents();
  renderTools();
  await Promise.all([loadSchedules(), loadRuns()]);
}

async function loadAgents() {
  const body = await api("list_agents");
  state.agents = body.agents || [];
  if (!state.selectedAgentId && state.agents.length) state.selectedAgentId = state.agents[0].id;
  if (state.selectedAgentId && !state.agents.some((a) => a.id === state.selectedAgentId)) {
    state.selectedAgentId = state.agents[0]?.id || null;
  }
  renderAgents();
}

async function loadSchedules() {
  if (!state.selectedAgentId) { state.schedules = null; renderAutoControls(); return; }
  const body = await api("get_auto", { agentId: state.selectedAgentId });
  state.schedules = { auto: body.auto || null };
  renderAutoControls();
  renderTools();
}

async function loadRuns() {
  if (!state.selectedAgentId) { state.runs = []; renderRuns(); return; }
  const agentId = state.selectedAgentId;
  const sessionEpoch = state.sessionEpoch;
  const body = await api("list_runs", { agentId, limit: 50 });
  if (state.selectedAgentId !== agentId || state.sessionEpoch !== sessionEpoch) return;
  state.runs = body.runs || [];
  renderRuns();
  renderTools();
}

// 一次刷新同时读设备心跳和运行记录；不碰表单、调度或采集命令。
let progressRefresh = null;
function loadProgress() {
  if (progressRefresh) return progressRefresh;
  const selected = state.selectedAgentId;
  const sessionEpoch = state.sessionEpoch;
  progressRefresh = (async () => {
    try {
      const devices = await api("list_agents");
      if (state.sessionEpoch !== sessionEpoch || state.selectedAgentId !== selected) return;
      const agents = devices.agents || [];
      const agentId = agents.some((row) => row.id === selected) ? selected : (agents[0]?.id || null);
      const history = agentId ? await api("list_runs", { agentId, limit: 50 }) : { runs: [] };
      if (state.sessionEpoch !== sessionEpoch || state.selectedAgentId !== selected) return;
      state.agents = agents;
      state.selectedAgentId = agentId;
      state.runs = history.runs || [];
      state.progressUpdatedAt = new Date().toISOString();
      state.progressError = null;
      renderAgents();
      renderRuns();
      renderTools();
      renderAutoStatus();
    } catch (error) {
      if (state.sessionEpoch === sessionEpoch && state.selectedAgentId === selected) {
        state.progressError = error.message || "网络请求失败";
        renderProgress();
      }
      throw error;
    } finally {
      progressRefresh = null;
    }
  })();
  return progressRefresh;
}

/** 手动采集：可选区间。`立即采集` = 按填的日期跑一轮；空着 = 最近 3 天 */
function ymd(date) {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

async function manualRun() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (!agent) { toast("先选一台采集机", "warn"); return; }
  const start = $("#manualStart").value.trim();
  const end = $("#manualEnd").value.trim();
  if ((start && !end) || (!start && end)) { toast("自定义区间要同时填开始和结束日期", "warn"); return; }
  if (start && end && start > end) { toast("开始日期不能晚于结束日期", "warn"); return; }

  const label = start && end ? `${start} ~ ${end}` : "最近 3 天";
  if (!window.confirm(`确定按「${label}」手动采集一轮（全部工具，按顺序）？\n\n如果自动采集还开着，建议先关掉它，避免两边抢。`)) return;

  setManualBusy(true, "正在下发…");
  try {
    const result = await api("send_command", {
      agentId: state.selectedAgentId, kind: "run_now", reportStart: start || undefined, reportEnd: end || undefined
    });
    toast(result.message || "已下发", "ok");
    setManualBusy(false, `已下发（${label}）。等当前任务跑完就开始，进度看上面「实时进度」。`);
    setTimeout(() => { loadProgress().catch(() => {}); }, 25000);
  } catch (error) {
    toast(`下发失败：${error.message}`, "error");
    setManualBusy(false, `下发失败：${error.message}`);
  }
}

async function manualStop() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (!agent) { toast("先选一台采集机", "warn"); return; }
  if (!window.confirm("停止本轮采集？\n\n当前正在采的那个工具会跑完（不丢数据），剩下的工具跳过，然后程序退出。")) return;
  setManualBusy(true, "正在下发…");
  try {
    const result = await api("send_command", { agentId: state.selectedAgentId, kind: "stop_collect" });
    toast(result.message || "已下发", "ok");
    setManualBusy(false, result.message || "已下发停止请求");
    setTimeout(() => { loadProgress().catch(() => {}); }, 25000);
  } catch (error) {
    toast(`下发失败：${error.message}`, "error");
    setManualBusy(false, `下发失败：${error.message}`);
  }
}

function fillPreset3Days() {
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400000);
  $("#manualStart").value = ymd(start);
  $("#manualEnd").value = ymd(end);
  setManualBusy(false, `已填入最近 3 天（${ymd(start)} ~ ${ymd(end)}）。点「立即采集」开始。`);
}

function setManualBusy(busy, text) {
  for (const id of ["#manualRun", "#manualStop", "#manualPreset3"]) {
    const node = $(id);
    if (node) node.disabled = busy;
  }
  const status = $("#manualStatus");
  if (status && text) status.textContent = text;
}

/** 保存全局自动采集设置（每 N 小时跑全部工具，与旧版一致） */
async function saveAuto() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  if (!agent) { toast("先选一台采集机", "warn"); return; }
  const intervalHours = Number($("#autoHours").value);
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
    toast("自动采集间隔必须是 1 至 168 的整数小时", "warn");
    return;
  }
  const expectedVersion = Number(state.schedules?.auto?.config_version || 0);
  try {
    const result = await api("save_auto", {
      agentId: state.selectedAgentId,
      enabled: $("#autoEnabled").checked,
      intervalHours,
      expectedVersion
    });
    toast(`已保存：每 ${intervalHours} 小时跑全部工具（云端 v${result.configVersion}）。等设备下一次心跳后会显示「设备已应用」。`, "ok");
    await loadSchedules();
    await loadAgents();
  } catch (error) {
    if (error.conflict) { toast(error.message, "warn"); await loadSchedules(); return; }
    toast(`保存失败：${error.message}`, "error");
  }
}

/** 可用采集流程：优先用设备上报的，保证与采集机上真实存在的流程一致 */
function deviceWorkflows() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const rows = agent?.status?.workflows;
  return Array.isArray(rows) ? rows : [];
}

function openAddTool() {
  if (!state.selectedAgentId) { toast("先选一台采集机", "warn"); return; }
  const workflows = deviceWorkflows();
  if (!workflows.length) {
    toast("采集机还没上报可用流程（它可能刚上线或程序没在运行）", "warn");
    return;
  }
  const select = $("#newToolWorkflow");
  select.innerHTML = workflows.map((row) => `<option value="${esc(row.id)}">${esc(row.name || row.id)}</option>`).join("");
  $("#newToolName").value = "";
  $("#toolError").textContent = "";
  $("#toolModal").classList.remove("hidden");
  $("#newToolName").focus();
}

/** 下发"新增工具"指令：真正执行在采集机上，这里只是排一条指令 */
async function submitAddTool() {
  const name = $("#newToolName").value.trim();
  const workflowId = $("#newToolWorkflow").value;
  const error = $("#toolError");
  error.textContent = "";
  if (!name) { error.textContent = "请填写工具名称"; return; }
  if (!workflowId) { error.textContent = "请选择采集流程"; return; }
  const button = $("#toolSave");
  button.disabled = true;
  try {
    await api("create_add_tool", { agentId: state.selectedAgentId, name, workflowId });
    $("#toolModal").classList.add("hidden");
    toast(`指令已下发：新增「${name}」。采集机大约 20 秒内领到，空闲时执行；成功后这里会出现这个工具。`, "ok");
    await refreshAll();
  } catch (e) {
    error.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

async function refreshAll() {
  try {
    await loadProgress();
    if (state.selectedAgentId) await loadSchedules();
  } catch (error) {
    toast(error.message, "error");
  }
}

function wireEvents() {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.session) loadProgress().catch(() => {});
  });
  $("#loginBtn").addEventListener("click", async () => {
    const button = $("#loginBtn");
    button.disabled = true;
    $("#loginError").textContent = "";
    try {
      const session = await signIn($("#email").value.trim(), $("#password").value);
      state.sessionEpoch += 1;
      state.session = session;
      saveSession(session);
      await loadAgents();
      await loadSchedules();
      await loadRuns();
      showMain();
    } catch (error) {
      $("#loginError").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#logoutBtn").addEventListener("click", () => { saveSession(null); state.session = null; showLogin(); });
  $("#refreshAgents").addEventListener("click", refreshAll);
  $("#refreshProgress").addEventListener("click", refreshAll);
  $("#refreshRuns").addEventListener("click", () => loadRuns().catch((e) => toast(e.message, "error")));
  $("#saveAuto").addEventListener("click", saveAuto);
  $("#manualRun").addEventListener("click", manualRun);
  $("#manualStop").addEventListener("click", manualStop);
  $("#manualPreset3").addEventListener("click", fillPreset3Days);
  // 日期框默认填「最近 3 天」，点开就能直接采；想改区间就改这两个框
  try { fillPreset3Days(); } catch { /* 老浏览器没有 date 控件也不影响其它功能 */ }
  $("#addTool").addEventListener("click", openAddTool);
  $("#toolCancel").addEventListener("click", () => $("#toolModal").classList.add("hidden"));
  $("#toolSave").addEventListener("click", submitAddTool);
  $("#agentSelect").addEventListener("change", (event) => {
    selectAgent(event.target.value).catch((e) => toast(e.message, "error"));
  });
  $("#passwordBtn").addEventListener("click", () => {
    $("#passwordError").textContent = "";
    $("#passwordModal").classList.remove("hidden");
    $("#newPassword").focus();
  });
  $("#passwordCancel").addEventListener("click", () => $("#passwordModal").classList.add("hidden"));
  $("#passwordSave").addEventListener("click", changePassword);
}

async function boot() {
  wireEvents();
  const session = loadSession();
  if (!session) { showLogin(); return; }
  state.session = session;
  try {
    await loadAgents();
    await loadSchedules();
    await loadRuns();
    showMain();
  } catch (error) {
    // 网络抖动不该把人踢下线。只有确实"登录失效"才回登录页，
    // 其它错误照常进主界面 + 弹提示（以前的写法是任何错误都清会话，太粗暴）。
    const message = error.message || "";
    if (/还没登录|invalid_token|missing_token|401/.test(message)) {
      saveSession(null);
      state.session = null;
      showLogin();
    } else {
      showMain();
      toast(message || "加载失败，请稍后重试", "error");
    }
  }
}

boot();
