"use strict";
/**
 * 采集管理台（网页版）脚本。
 *
 * 视觉沿用旧版采集中心（unified.css）的设计语言；这里只负责数据与交互。
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
  // 上面两个值都是设计成公开的；真正的权限判断全在服务端（登录令牌 + 邮箱白名单）。
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/collector-admin/api"
});

const SESSION_KEY = "qca-console-session";
const state = { session: null, agents: [], selectedAgentId: null, schedules: [], runs: [], adding: false };

// 工具显示名：优先用设备上报的名字，没有就用这张表兜底；表里没有就直接显示 id。
const TOOL_NAMES = {
  "liyang-tina": "李杨 tina",
  "liyang-tes": "李杨 tes",
  "huihe": "惠和",
  "yujianweilai-1": "域见未来 1",
  "tool5": "李杨赫丝"
};

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toolLabel(id) {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const fromDevice = (agent?.status?.toolNames || []).find((row) => row.id === id);
  return fromDevice?.name || TOOL_NAMES[id] || id;
}
function deviceTools() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  return Array.isArray(agent?.status?.tools) ? agent.status.tools : [];
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

// ---------------- 调管理接口 ----------------

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

/**
 * 改密码：调 Supabase 的"更新当前用户"接口，带自己的访问令牌。
 * 只有本人能改自己的密码，服务端校验令牌；页面不碰任何密钥。
 */
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
  if (agent.status?.draining) return { label: "在线（正在等采集跑完）", cls: "busy" };
  if (agent.status?.jobRunning) return { label: "在线（正在采集）", cls: "busy" };
  return { label: "在线", cls: "on" };
}

/** 顶部概览：和旧界面一样，一眼看到总数、失败数与当前状态 */
function renderOverview() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const online = agent ? onlineState(agent) : null;
  const set = (id, value) => { const node = $(id); if (node) node.textContent = value; };
  const onlineCount = state.agents.filter((a) => onlineState(a).cls !== "off").length;
  set("#agentCount", state.agents.length ? `${onlineCount}/${state.agents.length}` : "0");
  set("#toolCount", agent ? (agent.status?.toolCount ?? "—") : "—");
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
        : online.cls === "off" ? "采集机离线" : "空闲";
  }
}

function renderAgents() {
  const box = $("#agentList");
  if (!box) return;
  if (!state.agents.length) {
    box.innerHTML = '<div class="panel pad muted">还没有采集机接入。在采集机上双击安装包会自动登记。</div>';
    renderOverview();
    return;
  }
  box.innerHTML = state.agents.map((agent, index) => {
    const online = onlineState(agent);
    const s = agent.status || {};
    const picked = state.selectedAgentId === agent.id;
    const host = s.host || agent.name || agent.id;
    const tools = Number(s.toolCount || 0);
    return `<div class="agent ${picked ? "picked" : ""}" data-agent="${esc(agent.id)}">
      <span class="card-order">${index + 1}</span>
      <div class="agent-top">
        <div class="agent-avatar">${esc(String(host).slice(0, 1).toUpperCase())}</div>
        <div class="agent-title">
          <strong>${esc(host)}</strong>
          <span>${esc(agent.id)}</span>
        </div>
        <span class="pill ${online.cls}">${esc(online.label)}</span>
      </div>
      <div class="agent-meta">
        版本 <b>${esc(s.version || "—")}</b> · 工具 <b>${tools || "—"}</b> 套 · 配置 v${esc(agent.config_version || 0)}
        ${s.schedulerEnabled === false ? " · 自动调度未开" : ""}
      </div>
      ${agent.last_error ? `<div class="agent-meta error">设备报错：${esc(agent.last_error)}</div>` : ""}
      ${picked ? '<div class="agent-meta muted small">↓ 正在配置这台机器的定时任务</div>' : ""}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-agent]").forEach((node) => {
    node.addEventListener("click", () => selectAgent(node.dataset.agent));
  });
  renderOverview();
}

function weekdayLabel(days) {
  if (!Array.isArray(days) || days.length === 7) return "每天";
  const names = { 1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日" };
  return `周${days.map((d) => names[d] || d).join("、")}`;
}

/** 新增表单：只列出这台设备确实有、且还没配过的工具 */
function renderAddRow() {
  const used = new Set(state.schedules.map((row) => row.tool_id));
  const options = deviceTools().filter((id) => !used.has(id));
  if (!options.length) {
    return '<tr class="new-row"><td colspan="8" class="pad muted">这台设备的工具都已配置过，或它还没上报工具清单。</td></tr>';
  }
  return `<tr class="new-row" id="newRow">
    <td><input type="checkbox" data-nf="enabled" checked></td>
    <td><select data-nf="toolId">${options.map((id) => `<option value="${esc(id)}">${esc(toolLabel(id))}（${esc(id)}）</option>`).join("")}</select></td>
    <td><input type="time" data-nf="timeOfDay" value="07:00"></td>
    <td><input type="text" data-nf="timezone" size="12" value="Asia/Shanghai"></td>
    <td><input type="time" data-nf="winFrom"> – <input type="time" data-nf="winTo"></td>
    <td><select data-nf="missedPolicy"><option value="skip">跳过不补</option><option value="catchup">补跑一次</option></select></td>
    <td class="muted small">保存后先显示「云端已保存」，等设备拉取后变成「设备已应用」</td>
    <td><button class="table-btn primary" data-save-new>保存</button> <button class="table-btn" data-cancel-new>取消</button></td>
  </tr>`;
}

function renderSchedules() {
  const body = $("#scheduleBody");
  if (!body) return;
  if (!state.selectedAgentId) {
    body.innerHTML = '<tr><td colspan="8" class="muted pad">先在上面选一台采集机</td></tr>';
    renderOverview();
    return;
  }
  const addButton = $("#addSchedule");
  if (addButton) addButton.disabled = false;
  if (!state.schedules.length && !state.adding) {
    body.innerHTML = '<tr><td colspan="8" class="muted pad">这台采集机还没有定时配置。点右上角的「＋ 新增」给工具加一条。</td></tr>';
    renderOverview();
    return;
  }
  body.innerHTML = (state.adding ? renderAddRow() : "") + state.schedules.map((row) => {
    const saved = Number(row.config_version || 0);
    const applied = Number(row.applied_version || 0);
    const synced = applied >= saved;
    const stateCell = synced
      ? `<span class="pill on" title="设备已确认使用这一版">设备已应用 v${applied}</span>`
      : `<span class="pill wait" title="云端已保存，设备还没拉取">云端已保存 v${saved}，待应用</span>`;
    const win = row.run_window || {};
    return `<tr data-row="${esc(row.id)}" data-tool="${esc(row.tool_id)}" data-version="${esc(row.config_version || 0)}">
      <td><input type="checkbox" data-f="enabled" ${row.enabled ? "checked" : ""}></td>
      <td><b>${esc(row.tool_name || toolLabel(row.tool_id))}</b><div class="muted small">${esc(row.tool_id)}</div></td>
      <td><input type="time" data-f="timeOfDay" value="${esc(row.time_of_day || "")}"><div class="muted small">${esc(weekdayLabel(row.weekdays))}</div></td>
      <td><input type="text" data-f="timezone" size="12" value="${esc(row.timezone || "Asia/Shanghai")}"></td>
      <td><input type="time" data-f="winFrom" size="5" value="${esc(win.from || "")}"> – <input type="time" data-f="winTo" size="5" value="${esc(win.to || "")}"></td>
      <td>
        <select data-f="missedPolicy">
          <option value="skip" ${row.missed_policy === "skip" ? "selected" : ""}>跳过不补</option>
          <option value="catchup" ${row.missed_policy === "catchup" ? "selected" : ""}>补跑一次</option>
        </select>
      </td>
      <td>${stateCell}<div class="muted small">更新于 ${esc((row.updated_at || "").replace("T", " ").slice(0, 16))}</div></td>
      <td><button class="table-btn primary" data-save>保存</button></td>
    </tr>`;
  }).join("");

  body.querySelectorAll("[data-save]").forEach((button) => {
    button.addEventListener("click", () => saveRow(button.closest("tr")));
  });
  const saveNew = body.querySelector("[data-save-new]");
  if (saveNew) saveNew.addEventListener("click", () => saveNewRow());
  const cancelNew = body.querySelector("[data-cancel-new]");
  if (cancelNew) cancelNew.addEventListener("click", () => { state.adding = false; renderSchedules(); });
  renderOverview();
}

function runStatusPill(status) {
  const map = {
    success: ["成功", "on"], partial: ["部分成功", "wait"], failed: ["失败", "off"],
    skipped: ["已跳过", "wait"], running: ["执行中", "busy"]
  };
  const [label, cls] = map[status] || [status || "—", "wait"];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function renderRuns() {
  const body = $("#runBody");
  if (!body) return;
  if (!state.runs.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted pad">还没有执行记录。等到点采集跑完，这里会出现结果。</td></tr>';
    renderOverview();
    return;
  }
  const trigger = { schedule: "按定时", catchup: "补跑", manual: "手动" };
  body.innerHTML = state.runs.map((run) => `<tr>
      <td>${esc((run.planned_for || "").replace("T", " ").slice(0, 16))}</td>
      <td><b>${esc(run.tool_name || toolLabel(run.tool_id))}</b></td>
      <td>${runStatusPill(run.status)}</td>
      <td>${esc(trigger[run.trigger] || run.trigger)}</td>
      <td class="muted">v${esc(run.config_version ?? "—")}</td>
      <td class="muted small">${esc(JSON.stringify(run.summary || {}))}</td>
      <td><button class="table-btn" data-log="${esc(run.id)}">查看</button>
        <pre class="log hidden" data-log-body="${esc(run.id)}">${esc(run.log_tail || "（没有日志）")}</pre></td>
    </tr>`).join("");
  body.querySelectorAll("[data-log]").forEach((button) => {
    button.addEventListener("click", () => {
      const node = body.querySelector(`[data-log-body="${CSS.escape(button.dataset.log)}"]`);
      if (node) node.classList.toggle("hidden");
    });
  });
  renderOverview();
}

// ---------------- 行为 ----------------

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  const agent = state.agents.find((row) => row.id === agentId);
  $("#agentTitle").textContent = agent ? `${agent.status?.host || agent.name || agentId} 的定时任务` : "";
  renderAgents();
  await Promise.all([loadSchedules(), loadRuns()]);
}

async function loadAgents() {
  const body = await api("list_agents");
  state.agents = body.agents || [];
  if (!state.selectedAgentId && state.agents.length) await selectAgent(state.agents[0].id);
  else renderAgents();
}

async function loadSchedules() {
  const body = await api("list_schedules", { agentId: state.selectedAgentId });
  state.schedules = body.schedules || [];
  renderSchedules();
}

async function loadRuns() {
  const body = await api("list_runs", { agentId: state.selectedAgentId, limit: 50 });
  state.runs = body.runs || [];
  renderRuns();
}

/** 保存已有行：带 expectedVersion（乐观锁），别人先改过就提示刷新 */
async function saveRow(row) {
  const pick = (field) => row.querySelector(`[data-f="${field}"]`);
  const timeOfDay = pick("timeOfDay").value;
  const timezone = pick("timezone").value.trim() || "Asia/Shanghai";
  if (!timeOfDay) { toast("请先填每天几点跑", "warn"); return; }
  const winFrom = pick("winFrom").value;
  const winTo = pick("winTo").value;
  try {
    const result = await api("save_schedule", {
      agentId: state.selectedAgentId,
      expectedVersion: Number(row.dataset.version || 0),
      schedule: {
        toolId: row.dataset.tool,
        toolName: toolLabel(row.dataset.tool),
        enabled: pick("enabled").checked,
        timeOfDay,
        timezone,
        weekdays: null,
        runWindow: winFrom || winTo ? { from: winFrom || null, to: winTo || null } : {},
        missedPolicy: pick("missedPolicy").value
      }
    });
    toast(`已保存（云端配置 v${result.configVersion}）。设备下一次心跳应用后会变成「设备已应用」。`, "ok");
    await loadSchedules();
    await loadAgents();
  } catch (error) {
    if (error.conflict) {
      toast(error.message, "warn");
      await loadSchedules();
      return;
    }
    toast(`保存失败：${error.message}`, "error");
  }
}

/** 保存新增：expectedVersion=0 表示新建，服务端不会覆盖已有配置 */
async function saveNewRow() {
  const row = $("#newRow");
  if (!row) return;
  const pick = (field) => row.querySelector(`[data-nf="${field}"]`);
  const toolId = pick("toolId").value;
  const timeOfDay = pick("timeOfDay").value;
  const timezone = pick("timezone").value.trim() || "Asia/Shanghai";
  if (!timeOfDay) { toast("请先填每天几点跑", "warn"); return; }
  const winFrom = pick("winFrom").value;
  const winTo = pick("winTo").value;
  try {
    const result = await api("save_schedule", {
      agentId: state.selectedAgentId,
      expectedVersion: 0,
      schedule: {
        toolId,
        toolName: toolLabel(toolId),
        enabled: pick("enabled").checked,
        timeOfDay,
        timezone,
        runWindow: winFrom || winTo ? { from: winFrom || null, to: winTo || null } : {},
        missedPolicy: pick("missedPolicy").value
      }
    });
    state.adding = false;
    toast(`已保存 ${toolLabel(toolId)}：云端 v${result.configVersion}。等设备下一次心跳（约 20 秒）后会变成「设备已应用」。`, "ok");
    await loadSchedules();
    await loadAgents();
  } catch (error) {
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
  $("#addSchedule").addEventListener("click", () => {
    if (!state.selectedAgentId) { toast("先选一台采集机", "warn"); return; }
    state.adding = true;
    renderSchedules();
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
    showMain();
  } catch (error) {
    saveSession(null);
    state.session = null;
    showLogin();
    if (error.message) toast(error.message, "error");
  }
}

boot();
