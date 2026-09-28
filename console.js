"use strict";
/**
 * 采集管理台前端。
 *
 * 安全约定（这条最重要）：
 *   - 这个文件里**没有任何密钥**。没有 service role、没有管理密钥、没有 GitHub 令牌。
 *     只有 Supabase 的公开配置（URL + publishable key），它们本来就是设计成公开的。
 *   - 权限全在服务端：每次调用都带用户自己的登录令牌，服务端校验身份 + 邮箱白名单。
 *     前端"看不到按钮"不算权限，所以前端不做任何权限判断，也不缓存管理密钥。
 *   - 不引任何外部脚本/CDN：登录直接调 Supabase 的 auth REST 接口，页面自身没有第三方代码。
 */

const CONFIG = Object.freeze({
  supabaseUrl: "https://mabxdkjqilulkrmqrrgo.supabase.co",
  publishableKey: "sb_publishable_lfHpd1y1gCaQIDXfRkD_8w_O1bPMWGx",
  // 页面托管在 GitHub Pages，接口在 Supabase 函数上 —— 是跨域调用。
  // 上面两个值都是**设计成公开**的（publishable key 只用于登录换令牌，不含任何管理权限），
  // 真正的权限判断全在服务端（用户令牌 + 邮箱白名单）。
  apiPath: "https://mabxdkjqilulkrmqrrgo.supabase.co/functions/v1/collector-admin/api"
});

const SESSION_KEY = "qca-console-session";
const state = { session: null, agents: [], selectedAgentId: null, schedules: [], runs: [], adding: false };

// 工具显示名：优先用设备上报的名字（设备更新后会自动带上），没有就用这张表兜底。
// 表里没有的 id 直接显示 id 本身，不猜。
const TOOL_NAMES = {
  "liyang-tina": "李杨 tina",
  "liyang-tes": "李杨 tes",
  "huihe": "惠和",
  "yujianweilai-1": "域见未来 1",
  "tool5": "李杨赫丝"
};
function toolLabel(id) {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  const fromDevice = (agent?.status?.toolNames || []).find((row) => row.id === id);
  return fromDevice?.name || TOOL_NAMES[id] || id;
}
function deviceTools() {
  const agent = state.agents.find((row) => row.id === state.selectedAgentId);
  return Array.isArray(agent?.status?.tools) ? agent.status.tools : [];
}

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message, kind = "info") {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast ${kind}`;
  setTimeout(() => node.classList.add("hidden"), 4200);
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function saveSession(value) {
  if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else sessionStorage.removeItem(SESSION_KEY);
}

// ---------------- 登录（Supabase Auth，邮箱+密码） ----------------

async function signIn(email, password) {
  const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: CONFIG.publishableKey },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.error_description || body.msg || (response.status === 400 ? "邮箱或密码不对" : `登录失败（HTTP ${response.status}）`);
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
    if (response.status === 401) { saveSession(null); showLogin(); }
    throw new Error(body.message || body.error || `接口返回 ${response.status}`);
  }
  return body;
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

function renderAgents() {
  const box = $("#agentList");
  if (!state.agents.length) { box.innerHTML = '<p class="muted pad">还没有采集机接入。运行采集机安装包时会自动登记。</p>'; return; }
  box.innerHTML = state.agents.map((agent) => {
    const online = onlineState(agent);
    const s = agent.status || {};
    const picked = state.selectedAgentId === agent.id;
    return `<div class="agent ${picked ? "picked" : ""}" data-agent="${esc(agent.id)}">
      <div class="agent-top">
        <strong>${esc(s.host || agent.name || agent.id)}</strong>
        <span class="pill ${online.cls}">${esc(online.label)}</span>
      </div>
      <div class="agent-meta muted small">
        版本 ${esc(s.version || "—")} · 工具 ${esc(s.toolCount ?? 0)} 个 · 配置 v${esc(agent.config_version || 0)}
        ${s.schedulerEnabled === false ? " · 定时调度未开" : ""}
      </div>
      ${agent.last_error ? `<div class="agent-meta error small">设备报错：${esc(agent.last_error)}</div>` : ""}
    </div>`;
  }).join("");
  box.querySelectorAll("[data-agent]").forEach((node) => {
    node.addEventListener("click", () => selectAgent(node.dataset.agent));
  });
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
    <td><button class="primary small-btn" data-save-new>保存</button> <button class="ghost small-btn" data-cancel-new>取消</button></td>
  </tr>`;
}

function renderSchedules() {
  const body = $("#scheduleBody");
  if (!state.selectedAgentId) {
    body.innerHTML = '<tr><td colspan="8" class="muted pad">先在左边选一台采集机</td></tr>';
    return;
  }
  const addButton = $("#addSchedule");
  if (addButton) addButton.disabled = false;
  if (!state.schedules.length && !state.adding) {
    body.innerHTML = '<tr><td colspan="8" class="muted pad">这台采集机还没有定时配置。点右上角的「新增」为工具加一条。</td></tr>';
    return;
  }
  body.innerHTML = (state.adding ? renderAddRow() : "") + state.schedules.map((row) => {
    const saved = Number(row.config_version || 0);
    const applied = Number(row.applied_version || 0);
    const synced = applied >= saved;
    const stateCell = synced
      ? `<span class="pill on" title="设备已确认使用这一版">设备已应用 v${applied}</span>`
      : `<span class="pill wait" title="云端已保存，设备还没拉取">云端已保存 v${saved}，设备待应用</span>`;
    const window = row.run_window || {};
    return `<tr data-row="${esc(row.id)}" data-tool="${esc(row.tool_id)}" data-version="${esc(row.config_version || 0)}">
      <td><input type="checkbox" data-f="enabled" ${row.enabled ? "checked" : ""}></td>
      <td>${esc(row.tool_name || row.tool_id)}<div class="muted small">${esc(row.tool_id)}</div></td>
      <td><input type="time" data-f="timeOfDay" value="${esc(row.time_of_day || "")}"><div class="muted small">${esc(weekdayLabel(row.weekdays))}</div></td>
      <td><input type="text" data-f="timezone" size="12" value="${esc(row.timezone || "Asia/Shanghai")}"></td>
      <td><input type="time" data-f="winFrom" size="5" value="${esc(window.from || "")}"> – <input type="time" data-f="winTo" size="5" value="${esc(window.to || "")}"></td>
      <td>
        <select data-f="missedPolicy">
          <option value="skip" ${row.missed_policy === "skip" ? "selected" : ""}>跳过不补</option>
          <option value="catchup" ${row.missed_policy === "catchup" ? "selected" : ""}>补跑一次</option>
        </select>
      </td>
      <td>${stateCell}<div class="muted small">更新于 ${esc((row.updated_at || "").replace("T", " ").slice(0, 16))}</div></td>
      <td><button class="primary small-btn" data-save>保存</button></td>
    </tr>`;
  }).join("");

  body.querySelectorAll("[data-save]").forEach((button) => {
    button.addEventListener("click", () => saveRow(button.closest("tr")));
  });
  // 新增行的按钮
  const saveNew = body.querySelector("[data-save-new]");
  if (saveNew) saveNew.addEventListener("click", () => saveNewRow());
  const cancelNew = body.querySelector("[data-cancel-new]");
  if (cancelNew) cancelNew.addEventListener("click", () => { state.adding = false; renderSchedules(); });
}

function runStatusPill(status) {
  const map = { success: ["成功", "on"], partial: ["部分成功", "wait"], failed: ["失败", "off"], skipped: ["已跳过", "wait"], running: ["执行中", "busy"] };
  const [label, cls] = map[status] || [status || "—", "wait"];
  return `<span class="pill ${cls}">${esc(label)}</span>`;
}

function renderRuns() {
  const body = $("#runBody");
  if (!state.runs.length) { body.innerHTML = '<tr><td colspan="7" class="muted pad">还没有执行记录</td></tr>'; return; }
  const trigger = { schedule: "按定时", catchup: "补跑", manual: "手动" };
  body.innerHTML = state.runs.map((run) => `<tr>
      <td>${esc((run.planned_for || "").replace("T", " ").slice(0, 16))}</td>
      <td>${esc(run.tool_name || run.tool_id)}</td>
      <td>${runStatusPill(run.status)}</td>
      <td>${esc(trigger[run.trigger] || run.trigger)}</td>
      <td class="muted">v${esc(run.config_version ?? "—")}</td>
      <td class="muted small">${esc(JSON.stringify(run.summary || {}))}</td>
      <td><button class="ghost small-btn" data-log="${esc(run.id)}">查看</button>
        <pre class="log hidden" data-log-body="${esc(run.id)}">${esc(run.log_tail || "（没有日志）")}</pre></td>
    </tr>`).join("");
  body.querySelectorAll("[data-log]").forEach((button) => {
    button.addEventListener("click", () => {
      const node = body.querySelector(`[data-log-body="${CSS.escape(button.dataset.log)}"]`);
      node.classList.toggle("hidden");
    });
  });
}

// ---------------- 行为 ----------------

async function selectAgent(agentId) {
  state.selectedAgentId = agentId;
  const agent = state.agents.find((row) => row.id === agentId);
  $("#agentTitle").textContent = agent ? `${agent.status?.host || agent.name || agentId} · ${agentId}` : "";
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
      // 乐观锁：带上"我这次是基于哪一版改的"，服务端对不上会返回冲突，
      // 避免把别人（或另一个标签页）刚保存的修改静默覆盖掉
      expectedVersion: Number(row.dataset.version || 0),
      schedule: {
        toolId: row.dataset.tool,
        toolName: row.querySelector("td:nth-child(2)").childNodes[0].textContent.trim(),
        enabled: pick("enabled").checked,
        timeOfDay,
        timezone,
        weekdays: null,               // 不传就沿用原来的星期
        runWindow: winFrom || winTo ? { from: winFrom || null, to: winTo || null } : {},
        missedPolicy: pick("missedPolicy").value
      }
    });
    toast(`已保存（云端配置 v${result.configVersion}）。设备下一次心跳应用后，这里会变成"设备已应用"。`, "ok");
    await loadSchedules();
    await loadAgents();
  } catch (error) {
    // 409 = 别人先改了这条配置：提示刷新，而不是把对方的修改盖掉
    if (/已经被改过/.test(error.message)) {
      toast(error.message, "warn");
      await loadSchedules();
      return;
    }
    toast(`保存失败：${error.message}`, "error");
  }
}

/** 保存新增的定时：expectedVersion=0 表示"新建"，服务端会拒绝覆盖已有配置 */
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
      await loadAgents();          // 服务端会校验管理员身份，不是管理员这里就会报错
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
    if (!state.selectedAgentId) { toast("先在左边选一台采集机", "warn"); return; }
    state.adding = true;
    renderSchedules();
  });
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
