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
const state = { session: null, agents: [], selectedAgentId: null, schedules: [], runs: [] };

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
function scheduleFor(toolId) {
  return state.schedules.find((row) => row.tool_id === toolId) || null;
}
function lastRunFor(toolId) {
  return state.runs.find((row) => row.tool_id === toolId) || null;
}

function toast(message, kind = "info") {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`;
  setTimeout(() => node.classList.add("hidden"), 4800);
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(value) {
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(SESSION_KEY);
}

// ---------------- 登录 ----------------

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
  return { accessToken: body.access_token, refreshToken: body.refresh_token, email };
}

async function api(action, payload = {}) {
  if (!state.session) throw new Error("还没登录");
  const response = await fetch(CONFIG.apiPath, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.session.accessToken}` },
    body: JSON.stringify({ action, ...payload })
  });
  const body = await response.json().catch(() => ({}));
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
    online.querySelector("span").textContent = s.label;
    online.className = `inline-status ${s.cls}`;
  }
  renderOverview();
}

/** 顶部概览：跟旧版一样，一眼看到总数、失败数与当前状态 */
function renderOverview() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const online = agent ? onlineState(agent) : null;
  const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  set("#toolCount", agent ? (agent.status?.toolCount ?? deviceTools().length) : "—");
  set("#scheduleCount", agent ? state.schedules.length : "—");
  set("#failCount", state.runs.filter((row) => row.status === "failed").length);
  const status = $("#jobStatus");
  const text = $("#jobStatusText");
  if (status && text) {
    const busy = Boolean(agent?.status?.jobRunning) || Boolean(agent?.status?.draining);
    status.classList.toggle("active", Boolean(agent) && !busy);
    status.classList.toggle("busy", Boolean(busy));
    text.textContent = !agent ? "等待数据"
      : busy ? (agent.status?.draining ? "正在收尾（等采集跑完）" : "正在采集")
        : online.cls === "off" ? "采集机离线" : "当前空闲";
  }
}

function runStatusPill(status) {
  const map = {
    success: ["成功", "on"], partial: ["部分成功", "wait"], failed: ["失败", "off"],
    skipped: ["已跳过", "wait"], running: ["执行中", "busy"]
  };
  const [label, cls] = map[status] || [status || "—", "wait"];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

/** 工具卡片：每套工具一张，卡片上直接设定时（跟旧版"客户采集工具"一样的位置） */
function renderTools() {
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
    const schedule = scheduleFor(toolId);
    const lastRun = lastRunFor(toolId);
    const accent = ACCENTS[index % ACCENTS.length];
    const saved = Number(schedule?.config_version || 0);
    const applied = Number(schedule?.applied_version || 0);
    const synced = saved > 0 && applied >= saved;
    const statusPill = !schedule ? '<span class="pill off">未配定时</span>'
      : synced ? `<span class="pill on">已应用 ${esc(schedule.time_of_day || "")}</span>`
        : `<span class="pill wait">已保存 ${esc(schedule.time_of_day || "")}·待应用</span>`;
    const lastText = !lastRun ? "还没有执行记录"
      : `${esc((lastRun.planned_for || "").replace("T", " ").slice(5, 16))} ${runStatusPill(lastRun.status)}`;
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
      <div class="tool-last">最近一次：${lastText}</div>
      <div class="tool-schedule">
        <label class="schedule-switch">
          <input type="checkbox" data-tf="enabled" ${schedule?.enabled === false ? "" : "checked"}>
          <span>每天</span>
        </label>
        <input type="time" data-tf="timeOfDay" value="${esc(schedule?.time_of_day || "07:00")}">
        <select data-tf="missedPolicy">
          <option value="skip" ${schedule?.missed_policy === "skip" ? "selected" : ""}>错过跳过</option>
          <option value="catchup" ${schedule?.missed_policy === "catchup" ? "selected" : ""}>错过补跑</option>
        </select>
        <button class="schedule-save" data-tool="${esc(toolId)}">${schedule ? "保存" : "设定时"}</button>
      </div>
      ${schedule ? `<div class="tool-hint muted small">云端 v${esc(saved)} · 设备已应用 v${esc(applied)}${synced ? "（已生效）" : "（等设备拉取）"}</div>`
        : '<div class="tool-hint muted small">这个工具还没有定时计划</div>'}
    </article>`;
  }).join("");
  grid.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => saveTool(button.closest(".client-card")));
  });
  renderOverview();
}

/** 运行动态：按旧版的列表样式，每条一行，可展开看日志 */
function renderRuns() {
  const list = $("#activityList");
  if (!list) return;
  if (!state.runs.length) {
    list.innerHTML = '<div class="empty-activity">还没有执行记录</div>';
    renderOverview();
    return;
  }
  const trigger = { schedule: "按定时", catchup: "补跑", manual: "手动" };
  list.innerHTML = state.runs.map((run) => `<div class="activity-item">
      <span class="activity-time">${esc((run.planned_for || "").replace("T", " ").slice(5, 16))}</span>
      <span class="activity-tool">${esc(run.tool_name || toolLabel(run.tool_id))}</span>
      ${runStatusPill(run.status)}
      <span class="activity-text">${esc(trigger[run.trigger] || run.trigger)} · 配置 v${esc(run.config_version ?? "—")} · ${esc(JSON.stringify(run.summary || {}))}</span>
      <button class="text-button" data-log="${esc(run.id)}">日志</button>
      <pre class="log hidden" data-log-body="${esc(run.id)}">${esc(run.log_tail || "（没有日志）")}</pre>
    </div>`).join("");
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
  renderAgents();
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
  if (!state.selectedAgentId) { state.schedules = []; renderTools(); return; }
  const body = await api("list_schedules", { agentId: state.selectedAgentId });
  state.schedules = body.schedules || [];
  renderTools();
}

async function loadRuns() {
  if (!state.selectedAgentId) { state.runs = []; renderRuns(); return; }
  const body = await api("list_runs", { agentId: state.selectedAgentId, limit: 50 });
  state.runs = body.runs || [];
  renderRuns();
}

/** 保存某个工具的定时：已有配置带版本号（乐观锁），没有则新建 */
async function saveTool(card) {
  const toolId = card.querySelector("[data-tool]").dataset.tool;
  const pick = (field) => card.querySelector(`[data-tf="${field}"]`);
  const existing = scheduleFor(toolId);
  const timeOfDay = pick("timeOfDay").value;
  if (!timeOfDay) { toast("请先选每天几点跑", "warn"); return; }
  try {
    const result = await api("save_schedule", {
      agentId: state.selectedAgentId,
      expectedVersion: existing ? Number(existing.config_version || 0) : 0,
      schedule: {
        toolId,
        toolName: toolLabel(toolId),
        enabled: pick("enabled").checked,
        timeOfDay,
        timezone: existing?.timezone || "Asia/Shanghai",
        runWindow: existing?.run_window || {},
        missedPolicy: pick("missedPolicy").value
      }
    });
    toast(`已保存 ${toolLabel(toolId)}：云端 v${result.configVersion}。等设备下一次心跳（约 20 秒）后会显示「已应用」。`, "ok");
    await loadSchedules();
    await loadAgents();
  } catch (error) {
    if (error.conflict) { toast(error.message, "warn"); await loadSchedules(); return; }
    toast(`保存失败：${error.message}`, "error");
  }
}

async function refreshAll() {
  try {
    await loadAgents();
    if (state.selectedAgentId) { await loadSchedules(); await loadRuns(); }
  } catch (error) {
    toast(error.message, "error");
  }
}

function wireEvents() {
  $("#loginBtn").addEventListener("click", async () => {
    const button = $("#loginBtn");
    button.disabled = true;
    $("#loginError").textContent = "";
    try {
      const session = await signIn($("#email").value.trim(), $("#password").value);
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
  $("#refreshRuns").addEventListener("click", () => loadRuns().catch((e) => toast(e.message, "error")));
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
    saveSession(null);
    state.session = null;
    showLogin();
    if (error.message) toast(error.message, "error");
  }
}

boot();
