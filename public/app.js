// Claude sessions. Four tabs, one sheet component, every behaviour is written down in UX.md.
// State comes from /api/state, refreshed every 10 s, on returning to the foreground, and after
// every action. Lists are patched in place (keyed by name) so a refresh never flickers.

// ---------- utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
};
const dur = (ms) => { const h = Math.floor(ms / 3600_000), m = Math.floor((ms % 3600_000) / 60_000); return h ? `${h}h ${m}m` : `${m}m`; };
const when = (ms) => {
  const d = new Date(ms), now = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `today ${t}` : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + t;
};
const clock = (iso) => { if (!iso) return ""; const d = new Date(iso), now = new Date(); const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); return d.toDateString() === now.toDateString() ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t; };
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n || 0);
const gb = (b) => b == null ? "?" : (b / 1073741824).toFixed(b > 1073741824 ? 1 : 2) + " GB";
const mb = (b) => b == null ? "?" : b > 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB";
const haptic = () => { try { navigator.vibrate?.(8); } catch {} };
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const toastEl = $("#toast");
function toast(msg, err = false) {
  clearTimeout(toastEl._t); clearTimeout(toastEl._t2);
  toastEl.hidden = false; toastEl.textContent = msg; toastEl.className = "toast" + (err ? " err" : "");
  toastEl._t = setTimeout(() => { toastEl.classList.add("bye"); toastEl._t2 = setTimeout(() => (toastEl.hidden = true), 170); }, err ? 5000 : 2200);
}
// A button that asks "Sure?" in place instead of a browser dialog, and forgets after 4 s.
function armConfirm(btn, label, onYes) {
  if (btn.dataset.armed) return;
  btn.dataset.armed = "1";
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="confirm">${esc(label)} <b>Yes</b> · No</span>`;
  const done = () => { delete btn.dataset.armed; btn.innerHTML = orig; btn.onclick = btn._orig; };
  btn._orig = btn.onclick;
  btn.onclick = (e) => { e.stopPropagation(); clearTimeout(t); if (e.target.tagName === "B") { done(); onYes(); } else done(); };
  const t = setTimeout(done, 4000);
}
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast(`Copied: ${text}`); } catch { prompt("Copy this:", text); } };

// A token in the link is stored as a cookie so later requests, including the terminal's
// websocket, carry it without it sitting in every URL.
const tokenParam = new URLSearchParams(location.search).get("token");
if (tokenParam) { document.cookie = `cs_token=${encodeURIComponent(tokenParam)}; path=/; max-age=31536000; samesite=lax`; history.replaceState(null, "", location.pathname + location.hash); }

// ---------- state ----------
let state = null;
let failing = false;
const banner = $("#banner");
async function refresh() {
  try {
    state = await api("GET", "/api/state");
    if (failing) { failing = false; banner.hidden = true; }
    renderAll();
  } catch (e) {
    if (!failing) { failing = true; banner.innerHTML = `<span>Can't reach the launcher. ${esc(e.message)}</span><button class="btn key small" id="retry">Retry</button>`; banner.hidden = false; $("#retry").onclick = refresh; }
  }
}
setInterval(() => { if (!Sheet.current) refresh(); }, 10000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { refresh(); if (tab === "usage") loadUsage(); if (tab === "skills") loadSkills(); } });
const dirLabel = (p) => state?.dirs.find((d) => d.path === p)?.label || p.split("/").filter(Boolean).pop();

// ---------- tabs ----------
const TABS = ["sessions", "usage", "skills", "startup", "settings"];
const scroller = $("#screens");
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : localStorage.getItem("tab") || "sessions";
const scrollPos = {};
function showTab(next, { fromHash = false } = {}) {
  if (next === tab && !fromHash) { scroller.scrollTo({ top: 0, behavior: "smooth" }); return; }
  scrollPos[tab] = scroller.scrollTop;
  tab = next; localStorage.setItem("tab", tab);
  if (!fromHash) history.pushState(null, "", "#" + tab);
  for (const s of $$(".screen")) { s.hidden = s.dataset.screen !== tab; if (!s.hidden) { s.style.animation = "none"; s.offsetHeight; s.style.animation = ""; } }
  for (const b of $$(".dock button")) b.classList.toggle("active", b.dataset.tab === tab);
  scroller.scrollTop = scrollPos[tab] || 0;
  if (tab === "usage") loadUsage();
  if (tab === "skills") loadSkills();
  if (tab === "settings") loadEvents();
}
$$(".dock button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
window.addEventListener("popstate", () => { const h = location.hash.slice(1); if (TABS.includes(h)) showTab(h, { fromHash: true }); });
// #start=<dir label or path> opens the start sheet straight from a home-screen shortcut.
const startParam = new URLSearchParams(location.hash.replace(/^#[a-z]*\??/, "")).get("start");
showTab(tab, { fromHash: true });

// ---------- keyed list patching ----------
function patchList(container, items, key, render, { enterClass = "fresh" } = {}) {
  const wanted = new Map(items.map((it) => [key(it), it]));
  for (const el of [...container.children]) {
    if (!wanted.has(el.dataset.key) && !el.classList.contains("leaving")) {
      el.classList.add("leaving"); el.style.height = el.offsetHeight + "px";
      setTimeout(() => el.remove(), 360);
    }
  }
  let prev = null;
  for (const it of items) {
    const k = key(it), html = render(it), sig = html;
    let el = [...container.children].find((c) => c.dataset.key === k && !c.classList.contains("leaving"));
    if (!el) {
      const tmp = document.createElement("div"); tmp.innerHTML = html; el = tmp.firstElementChild;
      el.dataset.key = k; el.classList.add(enterClass);
      container.insertBefore(el, prev ? prev.nextSibling : container.firstChild);
    } else if (el.dataset.sig !== sig) {
      const tmp = document.createElement("div"); tmp.innerHTML = html; const fresh = tmp.firstElementChild;
      el.className = fresh.className + (el.classList.contains("highlight") ? " highlight" : ""); el.innerHTML = fresh.innerHTML;
      if (prev ? prev.nextSibling !== el : container.firstChild !== el) container.insertBefore(el, prev ? prev.nextSibling : container.firstChild);
    }
    el.dataset.sig = sig; prev = el;
  }
}

// ---------- the sheet ----------
class Sheet {
  static current = null;
  constructor() {
    this.root = document.createElement("div");
    this.root.className = "sheet";
    this.root.innerHTML = `<div class="backdrop"></div><div class="panel" role="dialog" aria-modal="true"><div class="grabber"></div><div class="steps"></div></div>`;
    this.panel = $(".panel", this.root); this.stepsEl = $(".steps", this.root); this.steps = [];
    this.opener = document.activeElement;
    $(".backdrop", this.root).onclick = () => this.close();
    this.onKey = (e) => { if (e.key === "Escape") this.close(); };
    document.addEventListener("keydown", this.onKey);
    scroller.classList.add("locked");
    $("#sheet-root").appendChild(this.root);
    this.root.offsetHeight;
    this.root.classList.add("in");
    this.drag();
    Sheet.current = this;
  }
  push(html, wire) {
    const el = document.createElement("div"); el.className = "step"; el.innerHTML = html;
    const under = this.steps.at(-1);
    this.stepsEl.appendChild(el);
    if (under) { el.classList.add("push-in"); el.addEventListener("animationend", () => { el.classList.remove("push-in"); under.classList.add("under"); }, { once: true }); }
    this.steps.push(el); wire?.(el, this);
    const b = $(".back", el); if (b) b.onclick = () => this.back();
    if (this.steps.length === 1) $("button, input", el)?.focus?.({ preventScroll: true });
    this.body = $(".body", el);
    return el;
  }
  back() {
    if (this.steps.length < 2) return this.close();
    const top = this.steps.pop(), under = this.steps.at(-1);
    under.classList.remove("under"); top.classList.add("push-out");
    top.addEventListener("animationend", () => top.remove(), { once: true });
    setTimeout(() => top.remove(), 400);
    this.body = $(".body", under);
  }
  close() {
    if (this.closed) return; this.closed = true;
    document.removeEventListener("keydown", this.onKey);
    this.root.classList.remove("in", "dragging", "settling"); this.root.classList.add("out");
    this.panel.style.transform = ""; $(".backdrop", this.root).style.opacity = "";
    const done = () => { this.root.remove(); scroller.classList.remove("locked"); if (Sheet.current === this) Sheet.current = null; this.opener?.focus?.({ preventScroll: true }); this.onclose?.(); refresh(); };
    this.panel.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 300);
  }
  drag() {
    let y0 = 0, dy = 0, active = false, samples = [];
    const backdrop = $(".backdrop", this.root);
    const start = (y, target) => { const body = target.closest(".body"); if (body && body.scrollTop > 0) return false; if (target.closest(".term")) return false; y0 = y; dy = 0; active = true; samples = [[performance.now(), 0]]; return true; };
    const move = (y) => {
      if (!active) return false;
      dy = Math.max(0, y - y0);
      if (dy > 0) { this.root.classList.add("dragging"); this.panel.style.transform = `translateY(${dy}px)`; backdrop.style.opacity = String(Math.max(0, 1 - dy / this.panel.offsetHeight)); samples.push([performance.now(), dy]); if (samples.length > 6) samples.shift(); }
      return dy > 0;
    };
    const end = () => {
      if (!active) return; active = false;
      const [ta, da] = samples[0], [tb, db] = samples.at(-1);
      const v = tb > ta ? (db - da) / (tb - ta) : 0;
      this.root.classList.remove("dragging");
      if (dy > 70 || v > 0.5) return this.close();
      this.root.classList.add("settling"); this.panel.style.transform = ""; backdrop.style.opacity = "";
      setTimeout(() => this.root.classList.remove("settling"), 220);
    };
    this.panel.addEventListener("touchstart", (e) => { start(e.touches[0].clientY, e.target); }, { passive: true });
    this.panel.addEventListener("touchmove", (e) => { if (move(e.touches[0].clientY)) e.preventDefault(); else if (active && dy === 0 && e.touches[0].clientY < y0) active = false; }, { passive: false });
    this.panel.addEventListener("touchend", end); this.panel.addEventListener("touchcancel", end);
    this.panel.addEventListener("mousedown", (e) => { if (!e.target.closest(".grabber, .head") || e.target.closest("button, input")) return; start(e.clientY, e.target); const mm = (ev) => move(ev.clientY), mu = () => { end(); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); }; window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu); });
  }
}
const backBtn = `<button class="back key" aria-label="Back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>`;
const head = (title, path, { back = false, extra = "" } = {}) => `<div class="head"><div class="row">${back ? backBtn : ""}<div class="grow"><h3>${esc(title)}</h3>${path ? `<div class="path">${esc(path)}</div>` : ""}</div>${extra}</div></div>`;
const MODES = ["default", "auto", "acceptEdits", "plan"];

// ---------- status ----------
function pillFor(s) {
  if (s.dead) return `<span class="pill dead">exited ${s.exitStatus === 137 ? "· killed" : s.exitStatus}</span>`;
  if (s.wrapping) return `<span class="pill busy">wrapping up</span>`;
  if (s.needs?.kind === "permission") return `<span class="pill needs">needs permission</span>`;
  if (s.status === "busy") return `<span class="pill live">working</span>`;
  if (s.needs) return `<span class="pill needs">your turn</span>`;
  if (s.stale) return `<span class="pill stale">idle ${dur(s.idleFor)}</span>`;
  if (s.status === "idle") return `<span class="pill">idle ${dur(s.idleFor)}</span>`;
  return Date.now() - s.lastActivity < 20000 ? `<span class="pill live">active</span>` : `<span class="pill">quiet ${ago(s.lastActivity)}</span>`;
}
const needsCount = () => state ? state.sessions.filter((s) => !s.dead && s.needs && s.status !== "busy").length : 0;

// ---------- sessions tab ----------
const sessionsEl = $('[data-screen="sessions"]');
sessionsEl.innerHTML = `<header class="top"><h1>Sessions</h1><span class="sub" id="host"></span></header>
  <button class="btn key primary big" id="new-session">New session</button>
  <div class="card" id="memcard"></div>
  <div class="section-head"><h2>Running</h2><div id="running-actions"></div></div>
  <div id="session-list"></div><div class="empty" id="session-empty" hidden>Nothing running.</div>`;
$("#new-session").onclick = () => newSessionFlow("start");
function sessionCard(s) {
  const title = s.title && s.title !== "Untitled conversation" ? s.title : s.managed ? "Fresh conversation, nothing said yet" : "Not started by this app";
  const flag = !s.dead && s.needs && s.status !== "busy";
  return `<button class="card tappable key ${s.dead ? "dead" : ""} ${flag ? "needs" : ""}" data-session="${esc(s.name)}"><div class="row"><div class="grow"><div class="name">${esc(s.name)}</div><div class="title">${esc(title)}</div><div class="meta">${esc(s.path || "")} · up ${ago(s.createdAt)} · ${mb(s.memory)}${s.attached ? " · attached" : ""}</div></div>${pillFor(s)}</div></button>`;
}
function renderMemory() {
  const m = state.memory; if (!m || m.current == null) { $("#memcard").hidden = true; return; }
  $("#memcard").hidden = false;
  const max = m.max || 8 * 1073741824, pct = Math.min(100, (m.current / max) * 100);
  const cls = pct > 85 ? "bad" : pct > 65 ? "warn" : "";
  const top = [...state.sessions, ...state.screens].filter((s) => s.memory).sort((a, b) => b.memory - a.memory).slice(0, 4);
  $("#memcard").innerHTML = `<div class="meter-row"><span>Memory, all sessions</span><b>${gb(m.current)} of ${gb(max)}</b></div><div class="meter well"><i class="${cls}" style="width:${pct.toFixed(1)}%"></i></div>
    <div class="memlist">${top.map((s) => `<div><span>${esc(s.name)}</span><span>${mb(s.memory)}</span></div>`).join("")}</div>
    ${pct > 85 ? `<div class="inline-error">Near the ${gb(max)} rail.</div>` : ""}`;
}
function renderSessions() {
  const n = state.sessions.filter((s) => !s.dead).length, k = needsCount();
  $("#host").innerHTML = `${esc(state.host)} · ${n} running${k ? ` <span class="badge">${k}</span>` : ""}${state.limits?.fiveHour ? ` · 5h ${Math.round(state.limits.fiveHour.percent)}%` : ""}`;
  renderMemory();
  patchList($("#session-list"), state.sessions, (s) => s.name, sessionCard);
  $("#session-empty").hidden = state.sessions.length > 0;
  $$("#session-list [data-session]").forEach((b) => (b.onclick = () => sessionSheet(b.dataset.session)));
  const stale = state.sessions.filter((s) => s.stale && s.managed);
  $("#running-actions").innerHTML = stale.length ? `<button class="btn key small" id="close-idle">Close ${stale.length} idle</button>` : "";
  $("#close-idle")?.addEventListener("click", (e) => armConfirm(e.currentTarget, `Close ${stale.map((s) => s.name).join(", ")}?`, async () => { try { const r = await api("POST", "/api/close-idle"); toast(`Closed ${r.closed.join(", ") || "nothing"}`); refresh(); } catch (err) { toast(err.message, true); } }));
  const dockBadge = $('.dock [data-tab="sessions"] .badge'); if (k) { if (dockBadge) dockBadge.textContent = k; else $('.dock [data-tab="sessions"]').insertAdjacentHTML("beforeend", `<span class="badge">${k}</span>`); } else dockBadge?.remove();
  if (navigator.setAppBadge) { try { k ? navigator.setAppBadge(k) : navigator.clearAppBadge(); } catch {} }
}

// ---------- usage tab ----------
const usageEl = $('[data-screen="usage"]');
usageEl.innerHTML = `<header class="top"><h1>Usage</h1><span class="sub" id="usage-sub"></span></header>
  <div class="card" id="limits"></div>
  <div class="section-head"><h2>Tokens by conversation</h2><div class="seg well" id="usage-win"><button data-w="window" class="active">5h</button><button data-w="today">Today</button><button data-w="week">Week</button></div></div>
  <div class="card" id="usage-totals"></div>
  <div class="card" id="usage-list"><div class="empty">Loading…</div></div>
  <div class="empty">Ranked by output tokens, which the limits weigh most. Last 8 days.</div>`;
let usageWin = "window", usageData = null;
$$("#usage-win button").forEach((b) => (b.onclick = () => { usageWin = b.dataset.w; $$("#usage-win button").forEach((x) => x.classList.toggle("active", x === b)); renderUsage(); }));
async function loadUsage() { try { usageData = await api("GET", "/api/usage"); renderUsage(); } catch (e) { $("#usage-list").innerHTML = `<div class="inline-error">${esc(e.message)}</div>`; } }
function limitBar(label, l) {
  if (!l) return "";
  const pct = Math.round(l.percent), cls = pct > 85 ? "bad" : pct > 60 ? "warn" : "";
  return `<div class="meter-row" style="margin-top:8px"><span>${label}</span><b>${pct}% · resets ${clock(l.resetsAt)}</b></div><div class="meter well"><i class="${cls}" style="width:${pct}%"></i></div>`;
}
function renderUsage() {
  const u = usageData; if (!u) return;
  const lim = u.limits;
  if (u.limitsOff) {
    $("#limits").innerHTML = `<div class="meter-row"><span><b>Account limits</b></span></div><div class="meta" style="white-space:normal;margin-top:6px">Off. Turning this on lets the page read the Claude Code login token already saved on this machine and ask Anthropic for your own 5-hour and 7-day usage. It is sent nowhere else and never stored here.</div><button class="btn key small primary" style="margin-top:10px" id="limits-on">Turn on account limits</button>`;
    $("#limits-on").onclick = async () => { try { state = await api("PUT", "/api/config", { accountLimits: true }); toast("On"); loadUsage(); } catch (e) { toast(e.message, true); } };
  } else $("#limits").innerHTML = lim ? `<div class="meter-row"><span><b>Account limits</b></span></div>${limitBar("5-hour window", lim.fiveHour)}${limitBar("7-day, all models", lim.sevenDay)}${lim.limits.filter((l) => l.kind === "weekly_scoped").map((l) => limitBar(`7-day, ${l.model || "current model"}`, l)).join("")}` : `<div class="inline-error">Limits unavailable: ${esc(u.limitsError || "no data")}</div>`;
  const t = u.totals[usageWin];
  $("#usage-totals").innerHTML = `<div class="stat"><div><b>${tok(t.out)}</b><span>output</span></div><div><b>${tok(t.in + t.cw)}</b><span>input + cache writes</span></div><div><b>${t.n}</b><span>model calls</span></div></div>`;
  const rows = u.sessions.filter((s) => s[usageWin].n).sort((a, b) => b[usageWin].out - a[usageWin].out);
  const max = rows[0]?.[usageWin].out || 1;
  $("#usage-list").innerHTML = rows.length ? rows.slice(0, 25).map((s) => `<div class="usage-row"><div class="grow"><div class="t">${esc(s.title || "Untitled")}</div><div class="meta">${esc(s.label || "")}${s.runningIn ? ` · running as ${esc(s.runningIn)}` : ""} · ${s[usageWin].n} calls · ${tok(s[usageWin].cr)} cache reads</div><div class="bar"><i style="width:${(s[usageWin].out / max * 100).toFixed(1)}%"></i></div></div><div class="num">${tok(s[usageWin].out)}</div></div>`).join("") : `<div class="empty">${u.indexing ? "Indexing transcripts…" : "Nothing in this window."}</div>`;
  $("#usage-sub").textContent = u.indexing ? "indexing…" : "";
}

// ---------- skills tab ----------
const skillsEl = $('[data-screen="skills"]');
skillsEl.innerHTML = `<header class="top"><h1>Skills</h1><span class="sub" id="skills-sub"></span></header>
  <div class="card" id="skills-cost"></div>
  <button class="btn key primary big" id="skill-new" style="margin-top:10px">New skill</button>
  <input class="field well skillsearch" id="skill-q" placeholder="Search" autocapitalize="off" autocorrect="off" spellcheck="false">
  <div id="skills-list"><div class="empty">Loading…</div></div>`;
const MODE_LABEL = { "on": "", "name-only": "name only", "user-invocable-only": "slash only", "off": "off" };
const MODE_TAG = { "name-only": "mode", "user-invocable-only": "slash", "off": "off" };
let skillData = null, skillQ = "";
$("#skill-q").oninput = (e) => { skillQ = e.target.value.toLowerCase(); renderSkills(); };
$("#skill-new").onclick = newSkillSheet;
async function loadSkills() { try { skillData = await api("GET", "/api/skills"); renderSkills(); } catch (e) { $("#skills-list").innerHTML = `<div class="inline-error">${esc(e.message)}</div>`; } }
function skillRow(sk) {
  const dis = sk.source === "plugin" && !sk.pluginEnabled;
  const tags = [
    sk.source === "project" ? `<span class="tag">${esc(sk.projectLabel || "project")}</span>` : "",
    sk.source === "plugin" ? `<span class="tag">${esc(sk.plugin.split("@")[0])}</span>` : "",
    dis ? `<span class="tag off">plugin off</span>` : "",
    sk.mode !== "on" ? `<span class="tag ${MODE_TAG[sk.mode]}">${MODE_LABEL[sk.mode]}</span>` : "",
  ].join("");
  return `<div class="skill ${sk.mode === "off" || dis ? "muted" : ""}" data-skill="${esc(sk.name)}"><div class="grow"><div class="n">${esc(sk.name)}${tags}</div><div class="d">${esc(sk.description || "no description")}</div></div><div class="cost">${sk.cost ? sk.cost + "c" : "—"}</div></div>`;
}
function renderSkills() {
  const d = skillData; if (!d) return;
  const c = d.cost;
  // The bar is the share of everything installed that is actually being loaded, so switching
  // something off visibly shrinks it. There is no fixed ceiling to measure against: Claude
  // trims descriptions to fit about 1 percent of the context window.
  const most = d.skills.reduce((n, s) => n + s.name.length + 2 + s.descChars, 0);
  const pct = most ? (c.chars / most) * 100 : 0;
  $("#skills-cost").innerHTML = `<div class="meter-row"><span>Loaded into every session</span><b>${c.chars.toLocaleString()} chars</b></div><div class="meter well"><i class="${pct > 85 ? "warn" : ""}" style="width:${pct.toFixed(1)}%"></i></div><div class="meta" style="white-space:normal;margin-top:8px">${c.count} of ${c.total} skills describe themselves to Claude when a session starts, ${Math.round(pct)} percent of the ${most.toLocaleString()} characters your installed skills could cost. Claude trims this to fit about 1 percent of the context window.</div>`;
  const groups = [["yours", "Yours"], ["installed", "Installed"], ["anthropic", "Anthropic"]];
  const match = (sk) => !skillQ || sk.name.toLowerCase().includes(skillQ) || (sk.description || "").toLowerCase().includes(skillQ);
  $("#skills-list").innerHTML = groups.map(([g, label]) => {
    const rows = d.skills.filter((s) => s.group === g && match(s));
    if (!rows.length) return "";
    const chars = rows.reduce((n, s) => n + (s.source === "plugin" && !s.pluginEnabled ? 0 : s.cost), 0);
    return `<div class="group-head"><h2>${label}</h2><span>${rows.length} · ${chars.toLocaleString()} chars</span></div><div class="card">${rows.map(skillRow).join("")}</div>`;
  }).join("") || `<div class="empty">No match.</div>`;
  $$("#skills-list [data-skill]").forEach((el) => (el.onclick = () => skillSheet(el.dataset.skill)));
  $("#skills-sub").textContent = `${d.skills.length} total`;
}
function skillSheet(name) {
  const sk = skillData.skills.find((s) => s.name === name); if (!sk) return;
  const sheet = new Sheet();
  const where = sk.source === "user" ? "~/.claude/skills" : sk.source === "project" ? `${sk.projectLabel} · ${sk.project}/.claude/skills` : sk.source === "plugin" ? `${sk.plugin} plugin` : "Built into Claude Code";
  const step = sheet.push(`${head(sk.name, where)}
    <div class="body">
      <div class="setting" style="padding:2px 0 8px"><div><div>When Claude can use it</div></div></div>
      <div class="seg wide well" data-modes>
        <button data-m="on" class="${sk.mode === "on" ? "active" : ""}">On</button>
        <button data-m="name-only" class="${sk.mode === "name-only" ? "active" : ""}">Name only</button>
        <button data-m="user-invocable-only" class="${sk.mode === "user-invocable-only" ? "active" : ""}">Slash only</button>
        <button data-m="off" class="${sk.mode === "off" ? "active" : ""}">Off</button>
      </div>
      <div class="meta" style="white-space:normal;margin-top:8px" data-modehelp></div>
      ${sk.source === "plugin" ? `<div class="card setting" style="margin-top:12px"><div><div>${esc(sk.plugin.split("@")[0])} plugin</div><div class="meta">All ${skillData.skills.filter((x) => x.plugin === sk.plugin).length} of its skills</div></div><label class="switch"><input type="checkbox" data-plugin ${sk.pluginEnabled ? "checked" : ""}><span></span></label></div>` : ""}
      ${sk.source === "user" || sk.source === "plugin" ? `<div class="setting" style="padding:14px 0 6px"><div>Group</div><div class="seg well" data-group><button data-g="yours" class="${sk.group === "yours" ? "active" : ""}">Yours</button><button data-g="installed" class="${sk.group === "installed" ? "active" : ""}">Installed</button></div></div>` : ""}
      <div class="setting" style="padding:14px 0 6px"><div>Description <span class="meta">${sk.descChars} chars${sk.editable ? "" : ", read only"}</span></div></div>
      <textarea class="field well" data-desc ${sk.editable ? "" : "readonly"}>${esc(sk.description)}</textarea>
      ${sk.editable ? `<button class="btn key small" style="margin-top:8px" data-save>Save description</button>` : ""}
      <div class="inline-error" data-err hidden></div>
      ${sk.file ? `<details class="disclosure"><summary>SKILL.md${sk.files > 1 ? ` and ${sk.files - 1} more file${sk.files > 2 ? "s" : ""}` : ""}</summary><div data-md><div class="empty">Loading…</div></div></details>` : `<div class="meta" style="white-space:normal;margin-top:14px">This one lives inside Claude Code, so there is no file to read or edit. The switch above still applies.</div>`}
    </div>`, (el) => {
    const help = $("[data-modehelp]", el);
    const setHelp = (m) => { help.textContent = { "on": "Claude sees the name and description, and can pick it itself.", "name-only": "Claude sees the name but not the description. Cheapest way to keep it pickable.", "user-invocable-only": "Hidden from Claude. Still runs when you type the slash command.", "off": "Hidden from both." }[m]; };
    setHelp(sk.mode);
    $$("[data-modes] button", el).forEach((b) => (b.onclick = async () => {
      $$("[data-modes] button", el).forEach((x) => x.classList.toggle("active", x === b));
      setHelp(b.dataset.m);
      try { skillData = await api("POST", "/api/skill/mode", { name: sk.name, mode: b.dataset.m }); renderSkills(); toast("Applies to new sessions"); } catch (e) { toast(e.message, true); }
    }));
    $("[data-plugin]", el)?.addEventListener("change", async (ev) => { try { skillData = await api("POST", "/api/plugin/toggle", { id: sk.plugin, enabled: ev.target.checked }); renderSkills(); toast("Applies to new sessions"); } catch (e) { toast(e.message, true); } });
    $$("[data-group] button", el).forEach((b) => (b.onclick = async () => {
      $$("[data-group] button", el).forEach((x) => x.classList.toggle("active", x === b));
      try { skillData = await api("POST", "/api/skill/group", { name: sk.name, group: b.dataset.g }); renderSkills(); } catch (e) { toast(e.message, true); }
    }));
    $("[data-save]", el)?.addEventListener("click", async () => {
      const err = $("[data-err]", el); err.hidden = true;
      try { skillData = await api("PUT", "/api/skill/description", { file: sk.file, description: $("[data-desc]", el).value }); renderSkills(); toast("Saved"); }
      catch (e) { err.textContent = e.message; err.hidden = false; }
    });
    const det = $("details", el);
    det?.addEventListener("toggle", async () => {
      if (!det.open || det.dataset.loaded) return; det.dataset.loaded = "1";
      try { const r = await api("GET", `/api/skill/file?file=${encodeURIComponent(sk.file)}`); $("[data-md]", el).innerHTML = `<pre class="md">${esc(r.text)}</pre>`; }
      catch (e) { $("[data-md]", el).innerHTML = `<div class="inline-error">${esc(e.message)}</div>`; }
    });
  });
}
function newSkillSheet() {
  const sheet = new Sheet();
  const projects = state.dirs.filter((d) => d.pinned);
  sheet.push(`${head("New skill", "")}
    <div class="body">
      <div class="setting" style="padding:2px 0 6px"><div>Name</div></div>
      <input class="field well" data-name placeholder="deploy-rota" autocapitalize="off" autocorrect="off" spellcheck="false">
      <div class="setting" style="padding:14px 0 6px"><div>Description <span class="meta">what makes Claude pick it</span></div></div>
      <textarea class="field well" data-desc placeholder="Use when the user asks to…"></textarea>
      <div class="setting" style="padding:14px 0 6px"><div>Instructions <span class="meta">optional, editable later</span></div></div>
      <textarea class="field well" data-body style="min-height:120px"></textarea>
      <div class="setting" style="padding:14px 0 6px"><div>Where</div></div>
      <div class="seg wide well" data-scope><button data-s="user" class="active">Everywhere</button>${projects.slice(0, 3).map((p) => `<button data-s="${esc(p.path)}">${esc(p.label)}</button>`).join("")}</div>
      <div class="inline-error" data-err hidden></div>
    </div>
    <div class="foot"><button class="btn key primary" data-go>Create</button></div>`, (el) => {
    let scope = "user";
    $$("[data-scope] button", el).forEach((b) => (b.onclick = () => { scope = b.dataset.s; $$("[data-scope] button", el).forEach((x) => x.classList.toggle("active", x === b)); }));
    $("[data-go]", el).onclick = async () => {
      const btn = $("[data-go]", el), err = $("[data-err]", el); err.hidden = true; btn.disabled = true;
      try {
        const r = await api("POST", "/api/skill/new", { name: $("[data-name]", el).value, description: $("[data-desc]", el).value, body: $("[data-body]", el).value, scope });
        toast(`${r.name} created`); await loadSkills(); sheet.close();
      } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
    };
  });
}

// ---------- startup tab ----------
const startupEl = $('[data-screen="startup"]');
startupEl.innerHTML = `<header class="top"><h1>At startup</h1></header>
  <button class="btn key primary big" id="startup-add">Add a directory</button>
  <div class="section-head"><h2>Startup set</h2></div>
  <div id="startup-list"></div><div class="empty" id="startup-empty" hidden>Nothing yet.</div>
  <div class="section-head"></div><button class="btn key big" id="startup-run">Run the startup set now</button>`;
$("#startup-add").onclick = () => newSessionFlow("startup");
$("#startup-run").onclick = async () => {
  const b = $("#startup-run"); b.disabled = true;
  try { const r = await api("POST", "/api/startup/run"); toast(r.map((x) => x.started ? `started ${x.started}` : x.skipped ? `skipped, ${x.skipped}` : `error: ${x.error}`).join(" · ") || "Nothing to run"); await refresh(); }
  catch (e) { toast(e.message, true); } finally { b.disabled = false; }
};
const startupCard = (e, i) => `<div class="card" data-i="${i}"><div class="row"><div class="grow"><div class="name">${esc(dirLabel(e.path))}</div><div class="meta">${esc(e.path)}</div></div><button class="btn key small ghost danger" data-remove="${i}">Remove</button></div>
  <div class="seg wide well" style="margin-top:10px"><button class="${e.resume !== "fresh" ? "active" : ""}" data-mode="last" data-i="${i}">Resume</button><button class="${e.resume === "fresh" ? "active" : ""}" data-mode="fresh" data-i="${i}">Fresh</button></div></div>`;
function renderStartup() {
  patchList($("#startup-list"), state.startup.map((e, i) => ({ ...e, i })), (e) => e.path + "#" + e.i, (e) => startupCard(e, e.i));
  $("#startup-empty").hidden = state.startup.length > 0;
  $("#startup-run").disabled = !state.startup.length;
  $$("#startup-list [data-mode]").forEach((b) => (b.onclick = () => saveConfig({ startup: state.startup.map((e, i) => (i === Number(b.dataset.i) ? { ...e, resume: b.dataset.mode } : e)) })));
  $$("#startup-list [data-remove]").forEach((b) => (b.onclick = () => armConfirm(b, "Remove?", () => saveConfig({ startup: state.startup.filter((_, i) => i !== Number(b.dataset.remove)) }))));
}

// ---------- settings tab ----------
const settingsEl = $('[data-screen="settings"]');
settingsEl.innerHTML = `<header class="top"><h1>Settings</h1></header>
  <div class="card setting"><div><div>Default permission mode</div></div></div>
  <div class="seg wide well" id="mode-seg"></div>
  <div class="card setting" style="margin-top:14px"><div><div>Trust new folders for me</div><div class="meta">Answers the folder prompt for you.</div></div><label class="switch"><input type="checkbox" id="autoTrust"><span></span></label></div>
  <div class="card setting"><div><div>Resume after a memory-rail kill</div><div class="meta">Once, on the same conversation, with a Discord ping.</div></div><label class="switch"><input type="checkbox" id="autoResume"><span></span></label></div>
  <div class="card setting"><div><div>Discord ping when a session dies</div></div><label class="switch"><input type="checkbox" id="notifyOnExit"><span></span></label></div>
  <div class="card setting"><div><div>Account limits</div><div class="meta">Reads the Claude login token saved on this machine to fetch your own usage limits.</div></div><label class="switch"><input type="checkbox" id="accountLimits"><span></span></label></div>
  <div class="card setting"><div><div>Offer to close after</div><div class="meta">hours idle</div></div><input class="field well short" id="idleHours" inputmode="numeric"></div>
  <div class="card"><div>Wrap-up message</div><div class="meta" style="white-space:normal">Sent by Wrap up. The session closes when Claude finishes.</div><input class="field well" id="wrapPrompt" style="margin-top:8px" autocapitalize="off"></div>
  <div class="section-head"><h2>Pinned directories</h2></div><div class="card" id="pinned"></div>
  <div class="section-head"><h2>Old screen sessions</h2></div><div class="card" id="old-screens"></div>
  <div class="section-head"><h2>Event log</h2><button class="btn key small" id="events-refresh">Refresh</button></div><div class="card" id="events"><div class="empty">Loading…</div></div>
  <div class="section-head"><h2>How to attach</h2></div>
  <div class="card"><p style="margin:0 0 8px">From Termius on this box:</p><p style="margin:0"><code>cl</code> lists sessions, <code>cl rota-1</code> attaches.</p><p class="meta" style="white-space:normal;margin-top:8px">Detach with Ctrl-B then D. Own tmux socket, so plain <code>tmux ls</code> will not show them. Shortcut: <code>#sessions?start=&lt;label&gt;</code> opens the start sheet for a directory.</p></div>`;
for (const k of ["autoTrust", "autoResume", "notifyOnExit", "accountLimits"]) $("#" + k).onchange = (ev) => saveConfig({ [k]: ev.target.checked });
$("#idleHours").onchange = (ev) => saveConfig({ idleHours: Number(ev.target.value) });
$("#wrapPrompt").onchange = (ev) => saveConfig({ wrapPrompt: ev.target.value });
$("#events-refresh").onclick = loadEvents;
async function loadEvents() {
  try {
    const ev = await api("GET", "/api/events?limit=60");
    $("#events").innerHTML = ev.length ? ev.map((e) => { const { at, type, ...rest } = e; return `<div class="event"><time>${when(at)}</time><span class="k">${esc(type)}</span><span class="d">${esc(Object.entries(rest).filter(([k, v]) => v != null && k !== "sessionId").map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`).join(" "))}</span></div>`; }).join("") : `<div class="empty">Nothing yet.</div>`;
  } catch (e) { $("#events").innerHTML = `<div class="inline-error">${esc(e.message)}</div>`; }
}
function renderSettings() {
  $("#mode-seg").innerHTML = MODES.map((m) => `<button class="${state.defaults.permissionMode === m ? "active" : ""}" data-m="${m}">${m}</button>`).join("");
  $$("#mode-seg button").forEach((b) => (b.onclick = () => saveConfig({ defaults: { permissionMode: b.dataset.m } })));
  for (const k of ["autoTrust", "autoResume", "notifyOnExit", "accountLimits"]) $("#" + k).checked = state.settings[k];
  if (document.activeElement !== $("#idleHours")) $("#idleHours").value = state.settings.idleHours;
  if (document.activeElement !== $("#wrapPrompt")) $("#wrapPrompt").value = state.settings.wrapPrompt;
  const pinned = state.dirs.filter((d) => d.pinned);
  $("#pinned").innerHTML = pinned.length ? pinned.map((d) => `<div class="list-row"><div class="grow"><input class="label" value="${esc(d.label)}" data-path="${esc(d.path)}" aria-label="Label"><div class="meta">${esc(d.path)}</div></div><button class="btn key small ghost" data-unpin="${esc(d.path)}">Unpin</button></div>`).join("") : `<div class="empty">Nothing pinned.</div>`;
  $$("#pinned input.label").forEach((i) => (i.onchange = () => savePinned(pinned.map((d) => (d.path === i.dataset.path ? { path: d.path, label: i.value.trim() || d.label } : { path: d.path, label: d.label })))));
  $$("#pinned [data-unpin]").forEach((b) => (b.onclick = () => savePinned(pinned.filter((d) => d.path !== b.dataset.unpin).map((d) => ({ path: d.path, label: d.label })))));
  $("#old-screens").innerHTML = state.screens.length ? state.screens.map((s) => `<div class="list-row"><div class="grow"><div class="name">${esc(s.name)}</div><div class="title">${esc(s.title || "")}</div><div class="meta">${s.attached ? "attached" : "detached"} · ${s.status || "no claude inside"}${s.memory ? " · " + mb(s.memory) : ""}</div><div class="keys" style="margin-top:6px">${s.appUrl ? `<a class="btn key small link-btn" href="${esc(s.appUrl)}" target="_blank" rel="noopener">Open in Claude</a>` : ""}<button class="btn key small" data-copy="screen -r ${esc(s.name)}">Copy attach</button>${s.sessionId ? `<button class="btn key small" data-migrate="${esc(s.name)}">Move to tmux</button>` : ""}</div></div></div>`).join("") + `<div class="meta" style="white-space:normal;margin-top:8px">Move to tmux reopens the conversation as a launcher session. Detach an attached screen first.</div>` : `<div class="empty">None left.</div>`;
  $$("#old-screens [data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy)));
  $$("#old-screens [data-migrate]").forEach((b) => (b.onclick = () => armConfirm(b, "Move?", async () => { try { const r = await api("POST", "/api/screen/migrate", { name: b.dataset.migrate }); toast(`${b.dataset.migrate} is now ${r.name}`); refresh(); } catch (e) { toast(e.message, true); } })));
}
const savePinned = (pinned) => saveConfig({ pinned });
async function saveConfig(patch) {
  try { state = await api("PUT", "/api/config", patch); renderAll(); toast("Saved"); } catch (e) { toast(e.message, true); }
}
function renderAll() { renderSessions(); renderStartup(); renderSettings(); }

// ---------- flow: new session (mode "start") or add to startup (mode "startup") ----------
function newSessionFlow(mode, presetDir) {
  const sheet = new Sheet();
  const pinned = state.dirs.filter((d) => d.pinned), others = state.dirs.filter((d) => !d.pinned);
  const tile = (d) => { const n = state.sessions.filter((s) => s.path === d.path && !s.dead).length; return `<button class="tile key" data-dir="${esc(d.path)}" ${d.exists ? "" : "disabled"}><div class="name">${esc(d.label)}</div><div class="meta">${n ? `<span class="count">${n} running</span> · ` : ""}${d.conversations ? `${d.conversations} conversation${d.conversations === 1 ? "" : "s"}` : "new"}${d.exists ? "" : " · missing"}</div></button>`; };
  sheet.push(`${head(mode === "startup" ? "Add to startup" : "Where?", "")}
    <div class="body">
      <div class="tiles">${(pinned.length ? pinned : state.dirs).map(tile).join("")}</div>
      ${pinned.length && others.length ? `<details class="disclosure"><summary>Everything Claude has used (${others.length})</summary><div class="tiles">${others.map(tile).join("")}</div></details>` : ""}
      <details class="disclosure"><summary>New project</summary>
        <input class="field well" data-new-name placeholder="Name" autocapitalize="off" autocorrect="off" spellcheck="false">
        <input class="field well" data-new-parent value="${esc(state.home)}" style="margin-top:8px" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Folder to create it in">
        <div class="setting" style="padding:12px 0 6px"><div>git init</div><label class="switch"><input type="checkbox" data-new-git checked><span></span></label></div>
        <div class="inline-error" data-new-err hidden></div><button class="btn key primary" style="margin-top:4px;width:100%" data-new-go>Create</button></details>
      <details class="disclosure"><summary>Other path</summary><input class="field well" data-path placeholder="${esc(state.home)}/…" autocapitalize="off" autocorrect="off" spellcheck="false"><div class="inline-error" data-err hidden></div><button class="btn key" style="margin-top:8px" data-go>Continue</button></details>
    </div>`, (el) => {
    $("[data-new-go]", el).onclick = async () => {
      const btn = $("[data-new-go]", el), err = $("[data-new-err]", el); err.hidden = true; btn.disabled = true;
      try {
        const r = await api("POST", "/api/project", { name: $("[data-new-name]", el).value, parent: $("[data-new-parent]", el).value, git: $("[data-new-git]", el).checked });
        state = await api("GET", "/api/state"); toast(`${r.path} created`); pick(r.path);
      } catch (e) { err.textContent = e.message; err.hidden = false; } finally { btn.disabled = false; }
    };
    $$("[data-dir]", el).forEach((b) => (b.onclick = () => pick(b.dataset.dir)));
    $("[data-go]", el).onclick = async () => {
      const p = $("[data-path]", el).value.trim().replace(/^~/, state.home), err = $("[data-err]", el);
      const r = await api("GET", `/api/dir-check?path=${encodeURIComponent(p)}`).catch(() => ({ ok: false }));
      if (!r.ok) { err.textContent = "That is not a directory on this box."; err.hidden = false; return; }
      err.hidden = true; pick(p);
    };
  });
  async function pick(dir) {
    if (mode === "startup") { await saveConfig({ startup: [...state.startup, { path: dir, resume: "last" }] }); return sheet.close(); }
    conversationStep(sheet, dir);
  }
  if (presetDir) pick(presetDir);
}
function conversationStep(sheet, dir) {
  const d = state.dirs.find((x) => x.path === dir) || { path: dir, label: dir.split("/").filter(Boolean).pop(), pinned: false };
  const running = state.sessions.filter((s) => s.path === dir && !s.dead);
  const step = sheet.push(`${head(d.label, dir + (running.length ? ` · already running: ${running.map((s) => s.name).join(", ")}` : ""), { back: true })}
    <div class="body"><div class="empty">Loading conversations…</div></div>
    <div class="foot"><button class="btn key primary" data-start disabled>Start</button></div>`);
  api("GET", `/api/conversations?path=${encodeURIComponent(dir)}`).catch((e) => { toast(e.message, true); return []; }).then((convos) => {
    if (sheet.closed || !step.isConnected) return;
    const row = (c) => `<label class="opt ${c.runningIn ? "disabled" : ""}"><input type="radio" name="resume" value="${esc(c.id)}" ${c.runningIn ? "disabled" : ""}><div class="grow"><div class="t">${esc(c.title)}</div><div class="m">${c.runningIn ? `running in ${esc(c.runningIn)} · ` : ""}${when(c.mtime)} · ${(c.size / 1048576).toFixed(1)} MB</div><div class="m">${esc(c.lastPrompt)}</div></div></label>`;
    $(".body", step).innerHTML = `
      <label class="opt"><input type="radio" name="resume" value="" checked><div class="grow"><div class="t">Fresh conversation</div></div></label>
      <div data-convos>${convos.slice(0, 12).map(row).join("")}</div>
      ${convos.length > 12 ? `<button class="btn key small ghost" data-more style="width:100%">Show ${convos.length - 12} older</button>` : ""}
      <div class="setting" style="padding:14px 0 6px"><div>First message <span class="meta">optional</span></div></div>
      <textarea class="field well" data-first placeholder="First message" autocapitalize="sentences"></textarea>
      <details class="disclosure"><summary>Options</summary>
        <div class="setting" style="padding:6px 0"><div>Permission mode</div></div><div class="seg wide well" data-modes>${MODES.map((m) => `<button class="${m === state.defaults.permissionMode ? "active" : ""}" data-m="${m}">${m}</button>`).join("")}</div>
        <div class="setting" style="padding:12px 0 6px"><div>Name for tmux and Remote Control</div></div><input class="field well" data-label value="${esc(d.label)}" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="setting" style="padding:12px 0 6px"><div>Pinned to the front</div><label class="switch"><input type="checkbox" data-pin ${d.pinned ? "checked" : ""}><span></span></label></div>
      </details>
      <div class="inline-error" data-err hidden></div>`;
    let mode = state.defaults.permissionMode;
    $$("[data-modes] button", step).forEach((b) => (b.onclick = () => { mode = b.dataset.m; $$("[data-modes] button", step).forEach((x) => x.classList.toggle("active", x === b)); }));
    $("[data-more]", step)?.addEventListener("click", (e) => { $("[data-convos]", step).insertAdjacentHTML("beforeend", convos.slice(12).map(row).join("")); e.target.remove(); });
    const startBtn = $("[data-start]", step); startBtn.disabled = false;
    startBtn.onclick = async () => {
      startBtn.disabled = true; startBtn.innerHTML = `<span class="spinner"></span> Starting`;
      const err = $("[data-err]", step); err.hidden = true;
      try {
        const pin = $("[data-pin]", step).checked, label = $("[data-label]", step).value.trim() || d.label;
        if (pin !== !!d.pinned || label !== d.label) {
          const pinned = state.dirs.filter((x) => x.pinned && x.path !== dir).map((x) => ({ path: x.path, label: x.label }));
          if (pin) pinned.push({ path: dir, label });
          state = await api("PUT", "/api/config", { pinned });
        }
        const sessionId = $("input[name=resume]:checked", step).value || null;
        const initialPrompt = $("[data-first]", step).value.trim() || undefined;
        const r = await api("POST", "/api/start", { path: dir, sessionId, permissionMode: mode, initialPrompt });
        haptic(); toast(`${r.name} started`);
        sheet.onclose = () => { const el = $(`#session-list [data-session="${CSS.escape(r.name)}"]`); el?.classList.add("highlight"); };
        sheet.close();
      } catch (e) { err.textContent = e.message; err.hidden = false; startBtn.disabled = false; startBtn.textContent = "Start"; }
    };
  });
}

// ---------- the session sheet ----------
// ttyd's wire protocol, from its own client: one JSON text frame to authenticate and size, then
// binary frames whose first byte is the command: '0' input, '1' resize (client to server);
// '0' output, '1' title, '2' preferences (server to client). Subprotocol "tty".
class Term {
  constructor(el, name) {
    this.el = el; this.name = name;
    this.term = new Terminal({ fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", theme: { background: "#141312", foreground: "#e6e3dc", cursor: "#d97757", selectionBackground: "rgba(217,119,87,.35)" }, cursorBlink: true, scrollback: 3000, allowProposedApi: true });
    this.fit = new FitAddon.FitAddon(); this.term.loadAddon(this.fit);
    this.term.open(el); this.fit.fit();
    // Touches go to the element under the finger at touch-start, and xterm rebuilds its row
    // elements on every redraw. A drag that began on a span that has since been replaced is
    // delivered to a detached node and never reaches a handler on the container: the scroll
    // just stops. So touches land on this overlay, which is never re-rendered.
    this.touch = document.createElement("div"); this.touch.className = "term-touch"; el.appendChild(this.touch);
    this.enc = new TextEncoder(); this.dec = new TextDecoder();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(el);
    this.term.onData((d) => this.send("0" + d));
    this.touchScroll();
    this.connect();
  }
  // tmux has mouse mode on, so history lives in tmux, not in xterm's buffer. A finger drag on
  // the terminal is turned into wheel reports (SGR 1006, the encoding tmux asked for) sent down
  // the pty: finger down = wheel up = older lines, and tmux's copy mode takes it from there and
  // drops out again when scrolled back to the bottom. Captured before xterm sees the touch, so
  // xterm does not scroll its own empty viewport and the sheet does not move.
  touchScroll() {
    let y = null, acc = 0, v = 0, lastT = 0, raf = 0;
    const rowH = () => Math.max(8, this.el.clientHeight / this.term.rows);
    // Whole rows of accumulated movement become wheel reports, at most once per frame.
    const flush = () => {
      raf = 0;
      const h = rowH(); let n = 0;
      while (Math.abs(acc) >= h && n < 6) { const up = acc > 0; this.send("0\x1b[<" + (up ? 64 : 65) + ";1;1M"); acc += up ? -h : h; n++; }
    };
    const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };
    const stop = () => { cancelAnimationFrame(this.glide || 0); this.glide = 0; };
    const T = this.touch;
    T.addEventListener("touchstart", (e) => { stop(); y = e.touches[0].clientY; lastT = e.timeStamp; acc = 0; v = 0; e.stopPropagation(); }, { passive: true });
    T.addEventListener("touchmove", (e) => {
      if (y == null) return;
      e.preventDefault(); e.stopPropagation();
      const t = e.touches[0].clientY, dt = Math.max(1, e.timeStamp - lastT), dy = t - y;
      v = 0.7 * v + 0.3 * (dy / dt); y = t; lastT = e.timeStamp; acc += dy; queue();
    }, { passive: false });
    // A flick keeps going with friction, the way a native list does.
    const release = (e) => {
      e.stopPropagation(); if (y == null) return; y = null;
      let last = performance.now(), vel = v;
      if (Math.abs(vel) < 0.15) return;
      const step = (now) => { const dt = now - last; last = now; acc += vel * dt; vel *= Math.pow(0.94, dt / 16); flush(); if (Math.abs(vel) > 0.03) this.glide = requestAnimationFrame(step); else this.glide = 0; };
      this.glide = requestAnimationFrame(step);
    };
    T.addEventListener("touchend", release);
    T.addEventListener("touchcancel", release);
  }
  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/term/ws?arg=${encodeURIComponent(this.name)}`, ["tty"]);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => { this.ws.send(JSON.stringify({ AuthToken: "", columns: this.term.cols, rows: this.term.rows })); this.term.focus(); };
    this.ws.onmessage = (ev) => { const b = new Uint8Array(ev.data); const cmd = String.fromCharCode(b[0]); if (cmd === "0") this.term.write(b.subarray(1)); };
    this.ws.onclose = () => { if (!this.closed) { this.term.write("\r\n\x1b[90m[terminal disconnected]\x1b[0m\r\n"); } };
    this.ws.onerror = () => {};
  }
  send(s) { if (this.ws?.readyState === 1) this.ws.send(this.enc.encode(s)); }
  resize() { try { this.fit.fit(); this.send("1" + JSON.stringify({ columns: this.term.cols, rows: this.term.rows })); } catch {} }
  close() { this.closed = true; cancelAnimationFrame(this.glide || 0); this.ro.disconnect(); try { this.ws?.close(); } catch {} this.term.dispose(); }
}
function sessionSheet(name) {
  const s0 = state.sessions.find((x) => x.name === name); if (!s0) return;
  const sheet = new Sheet();
  let timer = null, es = null, term = null;
  const useTerm = state.term && !s0.dead && typeof Terminal !== "undefined";
  const step = sheet.push(`${head(name, `${s0.title && s0.title !== "Untitled conversation" ? s0.title : "Fresh conversation"}`, { extra: `<span data-pill>${pillFor(s0)}</span>` })}
    <div class="body">
      <div class="meta" style="white-space:normal">${esc(s0.path || "")} · up ${ago(s0.createdAt)} · ${mb(s0.memory)}${s0.permissionMode && s0.permissionMode !== "default" ? " · " + esc(s0.permissionMode) : ""}${s0.claudeName && s0.claudeName !== name ? " · Claude calls it " + esc(s0.claudeName) : ""}</div>
      <div data-needs></div>
      <div data-exited></div>
      ${useTerm ? `<div class="term" data-term></div>` : `<pre class="screen well" data-screen>…</pre>`}
      <div class="keys" data-keys></div>
      <form class="sendline" data-send><input class="field well" placeholder="Message" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send"><button class="btn key">Send</button></form>
      <div class="keys" style="margin-top:14px">
        ${s0.appUrl ? `<a class="btn key small primary link-btn" href="${esc(s0.appUrl)}" target="_blank" rel="noopener">Open in Claude</a>` : ""}
        <button class="btn key small" data-copy>Copy attach</button>
        ${s0.managed ? `<button class="btn key small" data-wrap>Wrap up</button><button class="btn key small" data-restart>Restart</button>` : ""}
        <button class="btn key small danger" data-kill>${s0.dead ? "Close" : "Kill"}</button>
      </div>
    </div>`, (el) => {
    $("[data-copy]", el).onclick = () => copy(`cl ${name}`);
    $("[data-kill]", el).onclick = (e) => { const s = current(); if (s?.dead) return doKill(); armConfirm(e.currentTarget, "Kill?", doKill); };
    $("[data-restart]", el)?.addEventListener("click", (e) => { const s = current(); if (s?.dead) return doRestart(); armConfirm(e.currentTarget, "Restart?", doRestart); });
    $("[data-wrap]", el)?.addEventListener("click", (e) => armConfirm(e.currentTarget, "Wrap up?", async () => { try { await api("POST", "/api/wrapup", { name }); toast("Wrapping up"); refreshSheet(); } catch (err) { toast(err.message, true); } }));
    $("[data-send]", el).onsubmit = (ev) => { ev.preventDefault(); const i = $("input", ev.target); const t = i.value; i.value = ""; send({ text: t, keys: ["Enter"] }); };
  });
  const current = () => state.sessions.find((x) => x.name === name);
  // One scrolling strip of keys, the way Termius does it, plus a keyboard toggle that is fixed
  // at the right. Letters and punctuation are sent as text; the rest as tmux key names.
  const K = [
    ["Esc", { keys: ["Escape"] }], ["Tab", { keys: ["Tab"] }], ["⇧Tab", { keys: ["BTab"] }], ["Enter", { keys: ["Enter"] }],
    ["↑", { keys: ["Up"] }], ["↓", { keys: ["Down"] }], ["←", { keys: ["Left"] }], ["→", { keys: ["Right"] }],
    ["^C", { keys: ["C-c"] }], ["^D", { keys: ["C-d"] }], ["/", { text: "/" }], ["?", { text: "?" }],
    ["1", { text: "1" }], ["2", { text: "2" }], ["3", { text: "3" }], ["y", { text: "y" }], ["n", { text: "n" }],
    ["Space", { keys: ["Space"] }], ["⌫", { keys: ["BSpace"] }], ["PgUp", { keys: ["PPage"] }], ["PgDn", { keys: ["NPage"] }],
    ["Bottom", { keys: ["C-End"] }], ["^O", { keys: ["C-o"] }], ["^E", { keys: ["C-e"] }], ["^L", { keys: ["C-l"] }], ["^U", { keys: ["C-u"] }], ["^Z", { keys: ["C-z"] }],
  ];
  let lastText = "";
  function renderKeys(text, dead) {
    const trust = /trust this folder/i.test(text);
    const host = $("[data-keys]", step);
    host.innerHTML = dead ? "" : `<div class="strip">${trust ? `<button class="btn key small primary" data-k='{"keys":["Down","Enter"]}'>Trust this folder</button>` : ""}${K.map(([l, p]) => `<button class="btn key small" data-k='${JSON.stringify(p)}'>${l}</button>`).join("")}</div>${useTerm ? `<button class="btn key small kbd" data-kbd aria-label="Keyboard"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg></button>` : ""}`;
    $$("[data-k]", step).forEach((b) => (b.onclick = () => send(JSON.parse(b.dataset.k))));
    $("[data-kbd]", step)?.addEventListener("click", () => { if (!term) return; const ta = $(".xterm-helper-textarea", term.el); if (document.activeElement === ta) ta.blur(); else term.term.focus(); });
    $("[data-send]", step).hidden = dead;
  }
  async function send(payload) { haptic(); try { await api("POST", "/api/send", { name, ...payload }); if (!useTerm) setTimeout(loadScreen, 700); } catch (e) { toast(e.message, true); } }
  function paint(text) {
    const pre = $("[data-screen]", step); if (!pre) return;
    if (text !== lastText) { lastText = text; const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24 || !pre.dataset.ready; pre.textContent = text; if (atBottom) pre.scrollTop = pre.scrollHeight; pre.dataset.ready = "1"; }
  }
  async function loadScreen() { if (sheet.closed) return; try { const { lines } = await api("GET", `/api/peek?name=${encodeURIComponent(name)}`); paint(lines.join("\n")); renderKeys(lastText, current()?.dead); } catch (e) { paint(e.message); } }
  function refreshSheet() {
    const s = current(); if (!s) return;
    $("[data-pill]", step).innerHTML = pillFor(s);
    $("[data-needs]", step).innerHTML = s.needs && !s.dead && s.status !== "busy" ? `${s.needs.kind === "permission" ? `<div class="exited" style="background:#3d2a22;color:#ffd9c7">${esc(s.needs.message || "Claude is asking for permission.")}</div>` : ""}` : "";
    $("[data-exited]", step).innerHTML = s.dead ? `<div class="exited">Exited with code ${s.exitStatus}.</div>` : "";
    $("[data-kill]", step).textContent = s.dead ? "Close" : "Kill";
    const r = $("[data-restart]", step); if (r) r.textContent = s.dead ? "Start again" : "Restart";
    if (useTerm) renderKeys(lastText, s.dead);
  }
  async function doKill() { try { await api("POST", "/api/kill", { name }); toast(`${name} closed`); sheet.close(); } catch (e) { toast(e.message, true); } }
  async function doRestart() { try { const r = await api("POST", "/api/restart", { name }); toast(`${r.name} started`); sheet.close(); } catch (e) { toast(e.message, true); } }
  refreshSheet();
  if (useTerm) {
    renderKeys("", false);
    try { term = new Term($("[data-term]", step), name); setTimeout(() => term.resize(), 350); }
    catch (e) { $("[data-term]", step).classList.add("off"); $("[data-term]", step).textContent = "Terminal unavailable: " + e.message; }
    // Even with the terminal on screen, the trust prompt is worth a one-tap button: peek for it.
    es = new EventSource(`/api/stream?name=${encodeURIComponent(name)}`);
    es.onmessage = (ev) => { lastText = JSON.parse(ev.data); renderKeys(lastText, current()?.dead); };
  } else {
    es = new EventSource(`/api/stream?name=${encodeURIComponent(name)}`);
    es.onmessage = (ev) => { paint(JSON.parse(ev.data)); renderKeys(lastText, current()?.dead); };
    es.addEventListener("gone", () => { es.close(); loadScreen(); });
  }
  timer = setInterval(async () => { await refresh().catch(() => {}); refreshSheet(); }, 4000);
  const origClose = sheet.close.bind(sheet); sheet.close = () => { clearInterval(timer); es?.close(); term?.close(); origClose(); };
}

// ---------- boot ----------
refresh().then(() => {
  if (startParam && state) {
    const d = state.dirs.find((x) => x.label === startParam || x.path === startParam);
    if (d) newSessionFlow("start", d.path);
    history.replaceState(null, "", "#sessions");
  }
});
