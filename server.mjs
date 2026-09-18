// Claude session launcher (claude.home). One page: pick a directory, tick a conversation to
// resume (or leave it unticked for a fresh one), and it opens a tmux session in that directory
// running claude with Remote Control on, named <label>-<n>.
//
// WHY. Before this every reboot meant Termius, a screen per project, cd, claude, remote control,
// three times over. And screen cannot scroll in Termius without Ctrl-A [. tmux with mouse on
// scrolls by swiping, and the sessions are named so the phone (Remote Control) and the terminal
// call them the same thing.
//
// WHAT IT KNOWS. Three sources, all Claude Code's own:
//   ~/.claude/sessions/<pid>.json  the registry every running claude writes: real busy/idle
//                                  status, the /rename name, the Remote Control id.
//   hooks (settings.json, type http) POST here on Stop, Notification, UserPromptSubmit,
//                                  SessionEnd: the moment a session needs you.
//   ~/.claude/projects/**/*.jsonl   the transcripts: titles, and per-message token usage.
// Plus the account's live usage limits from the same endpoint /usage in Claude Code reads.
//
// The tmux server runs on its own socket (-L claude) so it lives inside THIS systemd unit's
// cgroup, where the memory rail from the 26 Aug leak still applies. The unit uses KillMode=process,
// so restarting this server leaves the sessions untouched. Attach with `cl rota-1`.
// The web terminal is ttyd (claude-term.service, 127.0.0.1:7681) proxied under /term/.
//
// No dependencies, file-based data in data/, LAN only. It runs commands on this box, so it must
// never be put through the Cloudflare tunnel.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const HOME = os.homedir();
const ROOT = path.dirname(new URL(import.meta.url).pathname);
// A second instance for demos or testing: DATA_DIR, TMUX_SOCKET, PORT and BIND are all overridable.
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const CONFIG_FILE = path.join(DATA, "config.json");
const LIVE_FILE = path.join(DATA, "live.json");
const EVENTS_FILE = path.join(DATA, "events.jsonl");
const USAGE_FILE = path.join(DATA, "usage-index.json");
const PROJECTS = path.join(HOME, ".claude", "projects");
const REGISTRY = path.join(HOME, ".claude", "sessions");
const CREDS = path.join(HOME, ".claude", ".credentials.json");
const SETTINGS = path.join(HOME, ".claude", "settings.json");
const USER_SKILLS = path.join(HOME, ".claude", "skills");
const PLUGIN_CACHE = path.join(HOME, ".claude", "plugins");
const PORT = Number(process.env.PORT || 8795);
const BIND = process.env.BIND || "0.0.0.0";
const TERM_PORT = Number(process.env.TERM_PORT || 7681);
const SOCKET = process.env.TMUX_SOCKET || "claude";
const UNIT = process.env.UNIT || "claude-sessions.service";

// ---------- small helpers ----------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n"); fs.renameSync(tmp, file); }
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "claude";
const projectDirFor = (dir) => path.join(PROJECTS, dir.replace(/[^A-Za-z0-9]/g, "-"));
const alive = (pid) => pid > 0 && fs.existsSync(`/proc/${pid}`);
// A pid can be reused after a reboot or a crash; the registry keeps the process start time
// (clock ticks, field 22 of /proc/<pid>/stat) so a stale entry is not mistaken for a live one.
function sameProcess(pid, procStart) {
  if (!alive(pid)) return false;
  if (!procStart) return true;
  try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return st.slice(st.lastIndexOf(")") + 2).split(" ")[19] === String(procStart); } catch { return false; }
}

// ---------- config and live state ----------
function loadConfig() {
  const c = readJson(CONFIG_FILE, {});
  return {
    pinned: Array.isArray(c.pinned) ? c.pinned : [],
    startup: Array.isArray(c.startup) ? c.startup : [],
    defaults: { permissionMode: "default", ...(c.defaults || {}) },
    notifyOnExit: c.notifyOnExit !== false,
    autoTrust: c.autoTrust !== false,
    autoResume: c.autoResume !== false,
    idleHours: Number(c.idleHours) > 0 ? Number(c.idleHours) : 6,
    wrapPrompt: typeof c.wrapPrompt === "string" && c.wrapPrompt.trim() ? c.wrapPrompt : "/handoff",
    lastSession: c.lastSession || {},
    skillGroups: c.skillGroups || {},
    // Reading your Claude Code OAuth token to fetch your own account limits is opt-in: a tool you
    // just downloaded should not touch a credentials file until you say so.
    accountLimits: c.accountLimits === true,
    // Optional shared secret. This app starts processes and types into them, so anything that can
    // reach it can run code as you. Empty = no check, which is only safe on a trusted network.
    token: typeof c.token === "string" ? c.token : (process.env.CLAUDE_SESSIONS_TOKEN || ""),
    // Whose skills count as "yours" rather than installed, on top of the single-file heuristic.
    ownerName: typeof c.ownerName === "string" ? c.ownerName : "",
  };
}
let config = loadConfig();
const saveConfig = () => writeJson(CONFIG_FILE, config);
let live = readJson(LIVE_FILE, {}); // tmux name -> {path, sessionId, permissionMode, startedAt, origin}
const saveLive = () => writeJson(LIVE_FILE, live);
const needs = new Map();   // sessionId -> {kind, at, message}
const wrapping = new Map(); // tmux name -> {sessionId, sentAt, promptSeen}
const resumed = new Map();  // tmux name -> last auto-resume time
function labelFor(dir) { const pin = config.pinned.find((p) => p.path === dir); return slug(pin?.label || path.basename(dir)); }

// ---------- event log ----------
function event(type, data = {}) {
  const e = { at: Date.now(), type, ...data };
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(e) + "\n");
  log(`event ${type}`, JSON.stringify(data));
}
function readEvents(limit = 80) {
  let lines = [];
  try { lines = fs.readFileSync(EVENTS_FILE, "utf8").trim().split("\n").filter(Boolean); } catch {}
  if (lines.length > 2000) fs.writeFileSync(EVENTS_FILE, lines.slice(-1000).join("\n") + "\n");
  return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function discord(title, body) {
  if (!config.notifyOnExit) return;
  run("discord-notify", ["--title", title, body]).catch((e) => log("discord-notify failed:", e.message));
}

// ---------- processes: the registry and the pid tree ----------
// Every running claude writes ~/.claude/sessions/<pid>.json. Walking each one's ancestors up to
// a tmux pane pid or a screen pid says which of OUR sessions (or old screens) it is running in.
function readRegistry() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(REGISTRY).filter((f) => f.endsWith(".json")); } catch {}
  for (const f of files) {
    const j = readJson(path.join(REGISTRY, f), null);
    if (j && sameProcess(j.pid, j.procStart)) out.push(j);
  }
  return out;
}
function parentMap() {
  const parents = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      parents.set(Number(d), ppid);
    } catch {}
  }
  return parents;
}
function ancestors(pid, parents) { const out = []; let p = pid; for (let i = 0; i < 64 && p > 1; i++) { out.push(p); p = parents.get(p) || 0; } return out; }
function subtreeRss(rootPid, parents) {
  const children = new Map();
  for (const [c, p] of parents) { if (!children.has(p)) children.set(p, []); children.get(p).push(c); }
  const page = 4096; let total = 0; const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    try { total += Number(fs.readFileSync(`/proc/${p}/statm`, "utf8").split(" ")[1]) * page; } catch {}
    for (const c of children.get(p) || []) stack.push(c);
  }
  return total;
}
async function unitMemory() {
  try {
    const { stdout } = await run("systemctl", ["--user", "show", UNIT, "-p", "MemoryCurrent", "-p", "MemoryMax", "-p", "MemoryHigh"]);
    const o = Object.fromEntries(stdout.trim().split("\n").map((l) => l.split("=")));
    const num = (v) => (v === "infinity" || v === undefined || v === "[not set]" ? null : Number(v));
    return { current: num(o.MemoryCurrent), max: num(o.MemoryMax), high: num(o.MemoryHigh) };
  } catch { return { current: null, max: null, high: null }; }
}

// ---------- tmux ----------
async function tmux(...args) { const { stdout } = await run("tmux", ["-L", SOCKET, ...args], { maxBuffer: 4 << 20 }); return stdout; }
async function listSessions() {
  let out = "";
  try {
    out = await tmux("list-panes", "-a", "-F", "#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_dead}\t#{pane_dead_status}\t#{window_activity}\t#{pane_pid}");
  } catch (e) {
    if (/no server running|No such file/.test(String(e.stderr || e.message))) return [];
    throw e;
  }
  const seen = new Map();
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, created, attached, dead, deadStatus, activity, pid] = line.split("\t");
    if (seen.has(name)) continue;
    const meta = live[name] || {};
    seen.set(name, {
      name, path: meta.path || null, label: meta.path ? labelFor(meta.path) : name.replace(/-\d+$/, ""),
      sessionId: meta.sessionId || null, permissionMode: meta.permissionMode || null, origin: meta.origin || "unknown",
      createdAt: Number(created) * 1000, attached: attached !== "0", dead: dead === "1",
      exitStatus: dead === "1" ? Number(deadStatus) : null, lastActivity: Number(activity) * 1000,
      pid: Number(pid), managed: Boolean(live[name]),
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}
async function listScreens() {
  try {
    const { stdout } = await run("screen", ["-ls"]);
    return stdout.split("\n").map((l) => l.match(/^\s+(\d+)\.(\S+)\s+\(([^)]*)\)\s+\((\w+)\)/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), name: m[2], started: m[3], attached: m[4] === "Attached" }));
  } catch { return []; }
}
function nextName(label, sessions) {
  const taken = new Set(sessions.filter((s) => s.name.startsWith(label + "-")).map((s) => s.name));
  for (let n = 1; ; n++) if (!taken.has(`${label}-${n}`)) return `${label}-${n}`;
}
// "=name:" is an exact session match plus its current window; a bare "=name" satisfies
// kill-session but capture-pane and send-keys want a pane target.
async function peek(name, lines = 40) {
  const out = await tmux("capture-pane", "-p", "-J", "-t", `=${name}:`, "-S", String(-lines));
  return out.replace(/\s+$/, "").replace(/^(\s*\n)+/, "").replace(/(\s*\n){3,}/g, "\n\n").split("\n");
}
const KEYS = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Tab", "BTab", "BSpace", "DC", "Home", "End", "PPage", "NPage", "Space", "C-a", "C-b", "C-c", "C-d", "C-e", "C-k", "C-l", "C-o", "C-r", "C-u", "C-w", "C-z", "C-End", "C-Home", "M-Enter"]);
async function sendKeys(name, { text, keys }) {
  if (typeof text === "string" && text.length) await tmux("send-keys", "-t", `=${name}:`, "-l", text);
  for (const k of keys || []) { if (!KEYS.has(k)) throw new Error(`Key not allowed: ${k}`); await tmux("send-keys", "-t", `=${name}:`, k); }
}

// ---------- starting, and what happens right after ----------
async function startSession({ path: dir, sessionId, permissionMode, initialPrompt, origin = "ui" }) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  const sessions = await listSessions();
  const label = labelFor(dir);
  const name = nextName(label, sessions);
  const id = sessionId || randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Bad session id");
  // A session that died before its first message has no file to resume, so it is started
  // fresh under the same id rather than failing with "no conversation".
  const fresh = !sessionId || !fs.existsSync(path.join(projectDirFor(dir), id + ".jsonl"));
  if (!fresh) {
    const running = sessions.find((s) => s.sessionId === id && !s.dead);
    if (running) throw new Error(`That conversation is already running in ${running.name}`);
    const reg = readRegistry().find((r) => r.sessionId === id);
    if (reg) throw new Error(`That conversation is already open elsewhere (pid ${reg.pid}, ${reg.name})`);
  }
  const mode = permissionMode || config.defaults.permissionMode || "default";
  // --name so the resume picker and Claude's own UI call it what the launcher calls it.
  const args = [fresh ? "--session-id" : "--resume", id, "--name", name];
  if (mode && mode !== "default") args.push("--permission-mode", mode);
  args.push("--remote-control", name);
  const cmd = `cd ${shq(dir)} && exec claude ${args.map(shq).join(" ")}`;
  await tmux("new-session", "-d", "-s", name, "-c", dir, "-x", "200", "-y", "50", "bash", "-lc", cmd);
  await tmux("set-option", "-g", "remain-on-exit", "on").catch(() => {});
  live[name] = { path: dir, sessionId: id, permissionMode: mode, startedAt: Date.now(), origin };
  saveLive();
  config.lastSession[dir] = id; saveConfig();
  event("start", { name, path: dir, sessionId: id, fresh, origin });
  settle(name, initialPrompt).catch((e) => log(`settle ${name}:`, e.message));
  return { name, sessionId: id };
}
// After launch: answer the trust prompt (if allowed), dismiss the Remote Control card that
// swallows keystrokes, then type the first message once the prompt box is up.
async function settle(name, initialPrompt) {
  const deadline = Date.now() + 120_000;
  let trusted = false, dismissed = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    let text;
    try { text = (await peek(name, 45)).join("\n"); } catch { return; }
    if (!trusted && config.autoTrust && /trust this folder/i.test(text)) {
      await sendKeys(name, { keys: ["Down", "Enter"] }); trusted = true; event("auto-trust", { name }); continue;
    }
    const ready = /shift\+tab to cycle|for agents|\/rc\s*$/m.test(text) || /^\s*[❯>]\s*$/m.test(text);
    if (!ready) continue;
    if (/Enter\/Esc to close/.test(text)) { if (!dismissed) { await sendKeys(name, { keys: ["Escape"] }); dismissed = true; } continue; }
    if (initialPrompt) { await sleep(400); await sendKeys(name, { text: initialPrompt, keys: ["Enter"] }); event("first-message", { name, chars: initialPrompt.length }); }
    return;
  }
}
async function killSession(name, why = "killed") {
  await tmux("kill-session", "-t", "=" + name);
  const meta = live[name]; delete live[name]; saveLive(); wrapping.delete(name);
  event(why, { name, path: meta?.path, sessionId: meta?.sessionId });
}
async function restartSession(name) {
  const meta = live[name]; if (!meta) throw new Error("Not a session this app started");
  await killSession(name, "restart");
  return startSession({ path: meta.path, sessionId: meta.sessionId, permissionMode: meta.permissionMode, origin: meta.origin });
}
async function wrapUp(name, prompt) {
  const meta = live[name]; if (!meta) throw new Error("Not a session this app started");
  const text = (prompt || config.wrapPrompt).trim();
  await sendKeys(name, { text, keys: ["Enter"] });
  wrapping.set(name, { sessionId: meta.sessionId, sentAt: Date.now(), promptSeen: false, sawBusy: false });
  event("wrap-up", { name, prompt: text });
}

// ---------- conversations (titles from the transcript) ----------
const convoCache = new Map();
async function readSlice(file, start, length) {
  const fh = await fsp.open(file, "r");
  try { const buf = Buffer.alloc(length); const { bytesRead } = await fh.read(buf, 0, length, start); return buf.subarray(0, bytesRead).toString("utf8"); }
  finally { await fh.close(); }
}
function lastMatch(text, re) { let m, last = null; while ((m = re.exec(text))) last = m; return last; }
const unq = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };
async function describeConversation(file, st) {
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = convoCache.get(file);
  if (hit && hit.key === key) return hit.value;
  const head = await readSlice(file, 0, 64 * 1024);
  const tail = st.size > 64 * 1024 ? await readSlice(file, st.size - 64 * 1024, 64 * 1024) : head;
  let first = null, cwd = null;
  for (const line of head.split("\n")) {
    if (!cwd) { const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (m) cwd = unq(m[1]); }
    if (first || !line.startsWith("{") || !line.includes('"type":"user"')) continue;
    try {
      const j = JSON.parse(line); if (j.isMeta) continue;
      const c = j.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => p.text).join(" ") : "";
      if (text && !text.trim().startsWith("<")) first = text.trim().slice(0, 200);
    } catch {}
  }
  const custom = lastMatch(tail, /"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g);
  const t = lastMatch(tail, /"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g);
  const p = lastMatch(tail, /"type":"last-prompt","lastPrompt":"((?:[^"\\]|\\.)*)"/g);
  // --name writes a custom-title equal to the tmux name, which is no title at all; a name the
  // user typed with /rename is kept, a launcher-shaped one falls through to Claude's own title.
  const customTitle = custom ? unq(custom[1]) : null;
  const useCustom = customTitle && !/^[a-z0-9-]+-\d+$/.test(customTitle);
  const value = {
    title: useCustom ? customTitle.slice(0, 110) : t ? unq(t[1]).slice(0, 110) : ((first || (p ? unq(p[1]) : "")).slice(0, 70) || "Untitled conversation"),
    lastPrompt: p ? unq(p[1]) : first || "", cwd,
  };
  convoCache.set(file, { key, value });
  return value;
}
async function conversationsFor(dir) {
  const pdir = projectDirFor(dir);
  let names = [];
  try { names = await fsp.readdir(pdir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const file = path.join(pdir, n);
    const st = await fsp.stat(file);
    if (st.size < 1500) continue;
    const d = await describeConversation(file, st);
    out.push({ id: n.slice(0, -6), mtime: st.mtimeMs, size: st.size, ...d });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
async function titleFor(dir, sessionId) {
  if (!dir || !sessionId) return null;
  const file = path.join(projectDirFor(dir), sessionId + ".jsonl");
  try { const st = await fsp.stat(file); return (await describeConversation(file, st)).title; } catch { return null; }
}
async function newestConversation(dir) { return (await conversationsFor(dir))[0]?.id || null; }

let knownCache = { at: 0, dirs: [] };
async function knownDirs() {
  if (Date.now() - knownCache.at < 60_000) return knownCache.dirs;
  const dirs = new Map();
  let entries = [];
  try { entries = await fsp.readdir(PROJECTS); } catch {}
  for (const e of entries) {
    if (e.startsWith("-tmp")) continue;
    const pdir = path.join(PROJECTS, e);
    let files; try { files = (await fsp.readdir(pdir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    let newest = null;
    for (const f of files) { const st = await fsp.stat(path.join(pdir, f)); if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: path.join(pdir, f), mtimeMs: st.mtimeMs }; }
    const head = await readSlice(newest.file, 0, 16 * 1024);
    const m = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (!m) continue;
    const cwd = unq(m[1]);
    if (cwd.startsWith("/tmp") || cwd.includes("/.claude/worktrees/") || !fs.existsSync(cwd)) continue;
    dirs.set(cwd, { path: cwd, lastUsed: newest.mtimeMs, conversations: files.length });
  }
  knownCache = { at: Date.now(), dirs: [...dirs.values()] };
  return knownCache.dirs;
}

// ---------- usage: the account limits and the per-conversation token index ----------
let limitsCache = { at: 0, value: null, error: null };
async function accountLimits() {
  if (!config.accountLimits) return { at: Date.now(), value: null, error: "off", disabled: true };
  if (Date.now() - limitsCache.at < 60_000) return limitsCache;
  try {
    const token = readJson(CREDS, {})?.claudeAiOauth?.accessToken;
    if (!token) throw new Error("no OAuth token in ~/.claude/.credentials.json");
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.258" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`usage endpoint ${r.status}`);
    const j = await r.json();
    const pick = (x) => x ? { percent: x.utilization, resetsAt: x.resets_at } : null;
    limitsCache = { at: Date.now(), error: null, value: { fiveHour: pick(j.five_hour), sevenDay: pick(j.seven_day), limits: (j.limits || []).map((l) => ({ kind: l.kind, percent: l.percent, resetsAt: l.resets_at, active: l.is_active, model: l.scope?.model?.id || null })) } };
  } catch (e) { limitsCache = { at: Date.now(), value: limitsCache.value, error: e.message }; }
  return limitsCache;
}
// Index: file -> {size, mtime, cwd, sessionId, buckets:{<10-min epoch>: {out, in, cr, cw, n}}, lastId}
// Transcripts are append-only, so a grown file is read from its old size. Only files touched in
// the last 8 days are indexed: that covers the weekly window and keeps the first pass to a few
// hundred MB instead of the whole gigabyte.
let usage = readJson(USAGE_FILE, { files: {} });
let indexing = false;
async function indexFile(file, st, entry) {
  const start = entry && st.size >= entry.size ? entry.size : 0;
  const fresh = start === 0 ? { size: 0, mtime: 0, cwd: null, sessionId: path.basename(file, ".jsonl"), buckets: {}, lastId: null, model: null } : { ...entry, buckets: { ...entry.buckets } };
  const stream = fs.createReadStream(file, { start, encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!fresh.cwd) { const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/); if (m) fresh.cwd = unq(m[1]); }
    if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const u = j.message?.usage; if (!u) continue;
    const id = j.message?.id || j.requestId || j.uuid;
    if (id && id === fresh.lastId) continue; // streamed content blocks repeat the same usage
    fresh.lastId = id;
    if (j.message?.model) fresh.model = j.message.model;
    const t = Date.parse(j.timestamp) || Date.now();
    const b = String(Math.floor(t / 600_000) * 600_000);
    const k = fresh.buckets[b] || (fresh.buckets[b] = { out: 0, in: 0, cr: 0, cw: 0, n: 0 });
    k.out += u.output_tokens || 0; k.in += u.input_tokens || 0; k.cr += u.cache_read_input_tokens || 0; k.cw += u.cache_creation_input_tokens || 0; k.n++;
  }
  fresh.size = st.size; fresh.mtime = st.mtimeMs;
  return fresh;
}
async function reindexUsage() {
  if (indexing) return; indexing = true;
  try {
    const cutoff = Date.now() - 8 * 86400_000;
    let entries = []; try { entries = await fsp.readdir(PROJECTS); } catch {}
    const seen = new Set(); let changed = 0;
    for (const e of entries) {
      if (e.startsWith("-tmp")) continue;
      const pdir = path.join(PROJECTS, e);
      let files; try { files = (await fsp.readdir(pdir)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
      for (const f of files) {
        const file = path.join(pdir, f);
        let st; try { st = await fsp.stat(file); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        seen.add(file);
        const entry = usage.files[file];
        if (entry && entry.size === st.size && entry.mtime === st.mtimeMs) continue;
        usage.files[file] = await indexFile(file, st, entry); changed++;
      }
    }
    for (const f of Object.keys(usage.files)) if (!seen.has(f)) delete usage.files[f];
    if (changed) writeJson(USAGE_FILE, usage);
  } catch (e) { log("usage index:", e.message); }
  finally { indexing = false; }
}
async function usageReport() {
  const lim = await accountLimits();
  const now = Date.now();
  const fiveStart = lim.value?.fiveHour?.resetsAt ? Date.parse(lim.value.fiveHour.resetsAt) - 5 * 3600_000 : now - 5 * 3600_000;
  const weekStart = lim.value?.sevenDay?.resetsAt ? Date.parse(lim.value.sevenDay.resetsAt) - 7 * 86400_000 : now - 7 * 86400_000;
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const windows = { window: fiveStart, today: dayStart.getTime(), week: weekStart };
  const perFile = [];
  const totals = { window: zero(), today: zero(), week: zero() };
  const byDay = {};
  for (const [file, e] of Object.entries(usage.files)) {
    const row = { sessionId: e.sessionId, cwd: e.cwd, model: e.model, window: zero(), today: zero(), week: zero(), lastAt: 0 };
    for (const [b, k] of Object.entries(e.buckets)) {
      const t = Number(b);
      if (t > row.lastAt) row.lastAt = t;
      for (const w of Object.keys(windows)) if (t >= windows[w]) { add(row[w], k); add(totals[w], k); }
      if (t >= weekStart) { const d = new Date(t).toISOString().slice(0, 10); byDay[d] = byDay[d] || zero(); add(byDay[d], k); }
    }
    if (row.week.n) perFile.push(row);
  }
  const sessions = await listSessions();
  for (const r of perFile) {
    r.title = await titleFor(r.cwd, r.sessionId);
    r.label = r.cwd ? labelFor(r.cwd) : null;
    r.runningIn = sessions.find((s) => s.sessionId === r.sessionId && !s.dead)?.name || null;
  }
  perFile.sort((a, b) => b.window.out - a.window.out || b.week.out - a.week.out);
  return { limits: lim.value, limitsError: lim.error, limitsOff: Boolean(lim.disabled), windows, totals, byDay, sessions: perFile.slice(0, 40), indexing };
}
function zero() { return { out: 0, in: 0, cr: 0, cw: 0, n: 0 }; }
function add(a, b) { a.out += b.out; a.in += b.in; a.cr += b.cr; a.cw += b.cw; a.n += b.n; }

// ---------- skills ----------
// Four sources, and only two of them are files we may touch:
//   user     ~/.claude/skills/<name>/SKILL.md          editable
//   project  <project>/.claude/skills/<name>/SKILL.md  editable
//   plugin   ~/.claude/plugins/cache/<mkt>/<plug>/<ver>/skills/  read-only, toggled per plugin
//   anthropic  compiled into Claude Code, no file at all: listable and switchable, not editable.
// The Anthropic list is per Claude Code version and cannot be read off disk, so it is written
// here; an entry that no longer exists simply shows as unavailable rather than breaking anything.
const BUNDLED = [
  ["code-review", "Review the current diff or a PR for correctness bugs and cleanups."],
  ["simplify", "Review changed code for reuse, simplification and efficiency, then apply the fixes."],
  ["security-review", "Security review of the pending changes on the current branch."],
  ["run", "Launch and drive this project's app to see a change working."],
  ["init", "Initialize a new CLAUDE.md with codebase documentation."],
  ["loop", "Run a prompt or slash command on a recurring interval."],
  ["schedule", "Create, update, list or run scheduled cloud agents (routines)."],
  ["update-config", "Configure the Claude Code harness via settings.json: hooks, permissions, env."],
  ["keybindings-help", "Customise keyboard shortcuts in ~/.claude/keybindings.json."],
  ["fewer-permission-prompts", "Scan transcripts and add a read-only allowlist to project settings."],
  ["claude-api", "Reference for the Claude API and Anthropic SDK: model ids, pricing, params, tools."],
  ["workflow-authoring", "Reference for writing a Workflow tool script."],
  ["claude-in-chrome", "Automate your Chrome browser: click, fill, screenshot, read console."],
  ["artifact-design", "Design guidance and fundamentals for Artifacts."],
  ["artifact-diagramming", "Diagramming know-how for Artifacts."],
  ["artifact-capabilities", "Runtime capabilities a published Artifact page can be granted."],
  ["design", "Create a multi-artboard design canvas published as an Artifact."],
  ["dataviz", "Read before writing any chart, dashboard or data visualisation."],
];
function readFrontmatter(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").slice(0, 16 * 1024); } catch { return {}; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!kv) continue;
    const key = kv[1]; let val = kv[2].trim();
    // Folded (>) and literal (|) block scalars: take the indented lines that follow.
    if (val === ">" || val === "|" || val === ">-" || val === "|-") {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) { parts.push(lines[++i].trim()); }
      val = parts.join(val[0] === "|" ? "\n" : " ").trim();
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}
function countFiles(dir) {
  let n = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else { n++; try { bytes += fs.statSync(full).size; } catch {} }
    }
  }
  return { files: n, bytes };
}
function skillsIn(root, source, extra = {}) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name), file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = readFrontmatter(file);
    const { files, bytes } = countFiles(dir);
    out.push({ name: fm.name || e.name, folder: e.name, description: fm.description || "", source, dir, file, files, bytes, editable: source === "user" || source === "project", ...extra });
  }
  return out;
}
function readSettings() { return readJson(SETTINGS, {}); }
function writeSettings(next) { writeJson(SETTINGS, next); }
function installedPlugins() {
  const j = readJson(path.join(PLUGIN_CACHE, "installed_plugins.json"), { plugins: {} });
  const enabled = readSettings().enabledPlugins || {};
  return Object.entries(j.plugins || {}).map(([id, rows]) => {
    const row = Array.isArray(rows) ? rows[0] : rows;
    return { id, installPath: row?.installPath || null, version: row?.version || null, enabled: enabled[id] !== false && id in enabled ? true : Boolean(enabled[id]) };
  });
}
// Which user-dir skills you wrote yourself: a hand-written skill is usually one SKILL.md, while
// anything installed from elsewhere arrives as a folder of many files. Set `ownerName` in the
// config and a skill that mentions you counts as yours however many files it has. A manual
// override always wins, because a heuristic should never be the last word.
function groupOf(sk) {
  const o = config.skillGroups?.[sk.name];
  if (o) return o;
  if (sk.source === "anthropic") return "anthropic";
  if (sk.source === "plugin") return "installed";
  if (sk.source === "project") return "yours";
  if (config.ownerName) {
    try { if (new RegExp(config.ownerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(fs.readFileSync(sk.file, "utf8"))) return "yours"; } catch {}
  }
  return sk.files <= 1 ? "yours" : "installed";
}
async function skillList() {
  const settings = readSettings();
  const overrides = settings.skillOverrides || {};
  const plugins = installedPlugins();
  let all = skillsIn(USER_SKILLS, "user");
  const dirs = new Set([...config.pinned.map((p) => p.path), ...(await knownDirs()).map((d) => d.path)]);
  // Home is a known directory, and its .claude/skills IS the user root: counting it as a
  // project would list every user skill twice.
  for (const d of dirs) {
    const root = path.join(d, ".claude", "skills");
    if (root === USER_SKILLS) continue;
    all = all.concat(skillsIn(root, "project", { project: d, projectLabel: labelFor(d) }));
  }
  for (const p of plugins) if (p.installPath) all = all.concat(skillsIn(path.join(p.installPath, "skills"), "plugin", { plugin: p.id, pluginEnabled: p.enabled }));
  for (const [name, description] of BUNDLED) all.push({ name, folder: name, description, source: "anthropic", dir: null, file: null, files: 0, bytes: 0, editable: false });
  for (const sk of all) {
    sk.mode = overrides[sk.name] || "on";
    sk.group = groupOf(sk);
    // What this skill costs a new session: the listing carries name plus description, and a
    // description is capped (default 1536 chars) before it is sent.
    const cap = Number(settings.skillListingMaxDescChars) > 0 ? Number(settings.skillListingMaxDescChars) : 1536;
    sk.descChars = Math.min(sk.description.length, cap);
    sk.cost = sk.mode === "on" ? sk.name.length + 2 + sk.descChars : sk.mode === "name-only" ? sk.name.length + 2 : 0;
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  const loaded = all.filter((s) => s.cost > 0 && !(s.source === "plugin" && !s.pluginEnabled));
  return {
    skills: all, plugins,
    cost: { chars: loaded.reduce((n, s) => n + s.cost, 0), count: loaded.length, total: all.length, capPerSkill: Number(settings.skillListingMaxDescChars) || 1536 },
  };
}
const MODES = new Set(["on", "name-only", "user-invocable-only", "off"]);
function setSkillMode(name, mode) {
  if (!MODES.has(mode)) throw new Error(`Mode must be one of ${[...MODES].join(", ")}`);
  const settings = readSettings();
  const o = { ...(settings.skillOverrides || {}) };
  if (mode === "on") delete o[name]; else o[name] = mode;
  if (Object.keys(o).length) settings.skillOverrides = o; else delete settings.skillOverrides;
  writeSettings(settings);
  event("skill-mode", { name, mode });
}
function setPluginEnabled(id, enabled) {
  const settings = readSettings();
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [id]: Boolean(enabled) };
  writeSettings(settings);
  event("plugin-toggle", { id, enabled: Boolean(enabled) });
}
// Only files inside the skill roots may be read or written through the app.
function skillFileOk(file) {
  if (!file || !path.isAbsolute(file) || !file.endsWith("SKILL.md")) return false;
  if (file.startsWith(USER_SKILLS + path.sep) || file.startsWith(PLUGIN_CACHE + path.sep)) return true;
  return /\/\.claude\/skills\//.test(file) && file.startsWith(HOME + path.sep);
}
function writeDescription(file, description) {
  if (!skillFileOk(file) || file.startsWith(PLUGIN_CACHE + path.sep)) throw new Error("That skill's files are not editable here");
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("No frontmatter in that SKILL.md");
  const desc = description.replace(/\s+/g, " ").trim();
  if (!desc) throw new Error("Description cannot be empty");
  // Rewrite the description key whatever shape it had (inline, folded or literal block).
  const lines = m[1].split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^description:/.test(lines[i])) { out.push(lines[i]); continue; }
    const val = lines[i].replace(/^description:\s?/, "").trim();
    if (val === ">" || val === "|" || val === ">-" || val === "|-") while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) i++;
    out.push("description: " + JSON.stringify(desc));
  }
  fs.writeFileSync(file, text.replace(m[0], "---\n" + out.join("\n") + "\n---"));
  event("skill-edit", { file });
}
function newSkill({ name, description, scope, body }) {
  const folder = slug(String(name || ""));
  if (!folder || folder.length > 64) throw new Error("Name: letters, digits and dashes");
  const root = !scope || scope === "user" ? USER_SKILLS : path.join(String(scope).replace(/^~/, HOME), ".claude", "skills");
  if (root !== USER_SKILLS && !fs.existsSync(path.dirname(path.dirname(root)))) throw new Error(`No such project: ${scope}`);
  const dir = path.join(root, folder);
  if (fs.existsSync(dir)) throw new Error(`${folder} already exists`);
  const desc = String(description || "").replace(/\s+/g, " ").trim();
  if (!desc) throw new Error("A description is what makes the skill findable. Write one line.");
  fs.mkdirSync(dir, { recursive: true });
  const md = `---\nname: ${folder}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${folder}\n\n${String(body || "").trim() || "Write the instructions here. Say what to do, in what order, and what not to do."}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), md);
  event("skill-new", { name: folder, root });
  return { name: folder, file: path.join(dir, "SKILL.md") };
}

// ---------- state ----------
async function state() {
  const [sessions, screens, known, mem] = await Promise.all([listSessions(), listScreens(), knownDirs(), unitMemory()]);
  const registry = readRegistry();
  const parents = parentMap();
  const byPane = new Map(sessions.map((s) => [s.pid, s]));
  const byScreen = new Map(screens.map((s) => [s.pid, s]));
  for (const r of registry) {
    for (const a of ancestors(r.pid, parents)) {
      const s = byPane.get(a); if (s) { s.claude = r; break; }
      const sc = byScreen.get(a); if (sc) { sc.claude = r; break; }
    }
  }
  const now = Date.now();
  for (const s of sessions) {
    const r = s.claude;
    if (r) {
      if (!s.sessionId) s.sessionId = r.sessionId;
      if (!s.path) s.path = r.cwd;
      s.claudeName = r.name; s.bridge = r.bridgeSessionId || null;
      s.status = r.status; s.statusSince = r.statusUpdatedAt || r.updatedAt || s.createdAt;
      if (r.status === "busy") needs.delete(r.sessionId);
    }
    s.appUrl = s.bridge ? `https://claude.ai/code/${s.bridge}` : null;
    s.needs = s.sessionId ? needs.get(s.sessionId) || null : null;
    s.idleFor = s.status === "idle" ? now - s.statusSince : 0;
    s.stale = !s.dead && s.status === "idle" && s.idleFor > config.idleHours * 3600_000;
    s.memory = s.dead ? 0 : subtreeRss(s.pid, parents);
    s.wrapping = wrapping.has(s.name);
    s.title = await titleFor(s.path, s.sessionId);
    delete s.claude;
  }
  for (const sc of screens) {
    const r = sc.claude;
    if (r) { sc.path = r.cwd; sc.sessionId = r.sessionId; sc.status = r.status; sc.claudeName = r.name; sc.appUrl = r.bridgeSessionId ? `https://claude.ai/code/${r.bridgeSessionId}` : null; sc.title = await titleFor(r.cwd, r.sessionId); sc.memory = subtreeRss(sc.pid, parents); }
    delete sc.claude;
  }
  const dirs = new Map();
  for (const p of config.pinned) dirs.set(p.path, { path: p.path, label: labelFor(p.path), pinned: true, exists: fs.existsSync(p.path), lastUsed: 0, conversations: 0 });
  for (const k of known) { const d = dirs.get(k.path) || { path: k.path, label: labelFor(k.path), pinned: false, exists: true }; dirs.set(k.path, { ...d, lastUsed: k.lastUsed, conversations: k.conversations }); }
  for (const s of sessions) if (s.path && !dirs.has(s.path)) dirs.set(s.path, { path: s.path, label: s.label, pinned: false, exists: fs.existsSync(s.path), lastUsed: 0, conversations: 0 });
  const lim = await accountLimits();
  return {
    host: os.hostname(), home: HOME, now, socket: SOCKET,
    dirs: [...dirs.values()].sort((a, b) => (b.pinned - a.pinned) || (b.lastUsed - a.lastUsed)),
    sessions, screens, memory: mem,
    limits: lim.value, limitsError: lim.error, limitsOff: Boolean(lim.disabled),
    startup: config.startup, defaults: config.defaults, lastSession: config.lastSession,
    settings: { notifyOnExit: config.notifyOnExit, autoTrust: config.autoTrust, autoResume: config.autoResume, idleHours: config.idleHours, wrapPrompt: config.wrapPrompt, accountLimits: config.accountLimits },
    term: termUp,
  };
}

// ---------- startup set ----------
async function runStartup(reason) {
  const sessions = await listSessions();
  const results = [];
  for (const entry of config.startup) {
    try {
      if (!fs.existsSync(entry.path)) { results.push({ entry, skipped: "directory is gone" }); continue; }
      let sessionId = null;
      if (entry.resume === "last") sessionId = config.lastSession[entry.path] || (await newestConversation(entry.path));
      else if (entry.resume && entry.resume !== "fresh") sessionId = entry.resume;
      const already = sessions.find((s) => !s.dead && s.path === entry.path && (sessionId ? s.sessionId === sessionId : s.origin === "startup"));
      if (already) { results.push({ entry, skipped: `already running as ${already.name}` }); continue; }
      const r = await startSession({ path: entry.path, sessionId, permissionMode: entry.permissionMode, origin: "startup" });
      sessions.push({ name: r.name, path: entry.path, sessionId: r.sessionId, origin: "startup", dead: false });
      results.push({ entry, started: r.name });
    } catch (e) { results.push({ entry, error: e.message }); log(`startup: ${entry.path} failed: ${e.message}`); }
  }
  event("startup-set", { reason, results: results.map((r) => r.started || r.skipped || r.error) });
  return results;
}
async function maybeRestoreAtBoot() {
  const uptime = os.uptime();
  const sessions = await listSessions();
  if (uptime > 20 * 60 || sessions.length) { log(`not a boot (uptime ${Math.round(uptime)}s, ${sessions.length} sessions), startup set left alone`); return; }
  if (!config.startup.length) return;
  await runStartup("boot");
}

// ---------- the watch: deaths, auto-resume, wrap-ups ----------
const notified = new Set();
async function watch() {
  try {
    const sessions = await listSessions();
    const registry = readRegistry();
    for (const s of sessions) {
      if (s.dead && !notified.has(s.name)) {
        notified.add(s.name);
        const why = s.exitStatus === 137 ? "killed (137, probably the memory rail)" : `exit code ${s.exitStatus}`;
        event("died", { name: s.name, path: s.path, exitStatus: s.exitStatus });
        const tail = (await peek(s.name, 6).catch(() => [])).join("\n");
        const canResume = config.autoResume && s.managed && s.exitStatus === 137 && Date.now() - (resumed.get(s.name) || 0) > 10 * 60_000;
        if (canResume) {
          resumed.set(s.name, Date.now());
          try { const r = await restartSession(s.name); event("auto-resume", { name: r.name }); discord(`Claude session ${s.name} hit the memory rail`, `${why}. Resumed it as ${r.name}.\n\`\`\`\n${tail.slice(-600)}\n\`\`\``); notified.delete(s.name); continue; }
          catch (e) { log("auto-resume failed:", e.message); }
        }
        discord(`Claude session ${s.name} stopped`, `${why}, in ${s.path}\n\`\`\`\n${tail.slice(-800)}\n\`\`\``);
      }
    }
    for (const n of [...notified]) if (!sessions.some((s) => s.name === n)) notified.delete(n);
    // A wrap-up ends when the session has been busy and is idle again (the hook path is faster,
    // this is the fallback), or gives up after 30 minutes.
    for (const [name, w] of wrapping) {
      const r = registry.find((x) => x.sessionId === w.sessionId);
      if (r?.status === "busy") w.sawBusy = true;
      // Fallback without hooks: the registry went idle after our prompt and has stayed idle.
      const done = r?.status === "idle" && (r.statusUpdatedAt || 0) > w.sentAt + 3000 && Date.now() - w.sentAt > 20_000 && (w.sawBusy || w.promptSeen);
      if (done) { await finishWrap(name); continue; }
      if (Date.now() - w.sentAt > 30 * 60_000) { wrapping.delete(name); event("wrap-up-timeout", { name }); }
    }
    let changed = false;
    for (const n of Object.keys(live)) if (!sessions.some((s) => s.name === n) && Date.now() - live[n].startedAt > 30_000) { delete live[n]; changed = true; }
    if (changed) saveLive();
  } catch (e) { log("watch:", e.message); }
}
async function finishWrap(name) {
  if (!wrapping.has(name)) return;
  wrapping.delete(name);
  try { await killSession(name, "wrapped-up"); discord(`Claude session ${name} wrapped up`, "Handoff finished, session closed."); }
  catch (e) { log("finishWrap:", e.message); }
}

// ---------- hooks from Claude Code ----------
function onHook(body) {
  const ev = body.hook_event_name, sid = body.session_id;
  if (!ev || !sid) return;
  if (ev === "Notification") {
    const kind = /permission/i.test(body.notification_type || body.matcher || "") || /permission/i.test(body.message || "") ? "permission" : "idle";
    needs.set(sid, { kind, at: Date.now(), message: (body.message || "").slice(0, 200) });
    const name = Object.keys(live).find((n) => live[n].sessionId === sid) || null;
    event("needs-you", { sessionId: sid, name, kind, cwd: body.cwd });
  } else if (ev === "Stop") {
    needs.set(sid, { kind: "done", at: Date.now(), message: "" });
    // The wrap-up prompt we typed raised UserPromptSubmit; the Stop after that is Claude done.
    for (const [name, w] of wrapping) if (w.sessionId === sid && w.promptSeen) finishWrap(name);
  } else if (ev === "UserPromptSubmit") {
    needs.delete(sid);
    for (const w of wrapping.values()) if (w.sessionId === sid) w.promptSeen = true;
  } else if (ev === "SessionEnd") {
    needs.delete(sid); event("session-end", { sessionId: sid, reason: body.reason, cwd: body.cwd });
  }
}

// ---------- ttyd (the web terminal) proxied under /term/ ----------
let termUp = false;
async function probeTerm() {
  try { const r = await fetch(`http://127.0.0.1:${TERM_PORT}/term/token`, { signal: AbortSignal.timeout(1500) }); termUp = r.ok; } catch { termUp = false; }
}
function proxyTerm(req, res) {
  const up = http.request({ host: "127.0.0.1", port: TERM_PORT, method: req.method, path: req.url, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => { res.writeHead(502, { "content-type": "text/plain" }); res.end("terminal service is down (claude-term.service)"); });
  req.pipe(up);
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };
function send(res, code, body, type = "application/json; charset=utf-8") { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(type.startsWith("application/json") ? JSON.stringify(body) : body); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", (c) => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
// The token may arrive as a header (API clients), a query parameter (the terminal websocket and
// a first visit by link), or the cookie the page sets from that parameter.
function authed(req, url) {
  if (!config.token) return true;
  const cookie = /(?:^|;\s*)cs_token=([^;]+)/.exec(req.headers.cookie || "");
  const given = req.headers["x-auth-token"] || url.searchParams.get("token") || (cookie && decodeURIComponent(cookie[1])) || "";
  return given === config.token;
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (!authed(req, url)) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("unauthorised"); }
  if (url.pathname.startsWith("/term/") || url.pathname === "/term") return proxyTerm(req, res);
  try {
    if (url.pathname.startsWith("/api/")) {
      const body = req.method === "GET" ? {} : await readBody(req);
      switch (`${req.method} ${url.pathname}`) {
        case "GET /api/state": return send(res, 200, await state());
        case "GET /api/conversations": {
          const dir = url.searchParams.get("path");
          const sessions = await listSessions(); const registry = readRegistry();
          const list = await conversationsFor(dir);
          for (const c of list) { const s = sessions.find((x) => x.sessionId === c.id && !x.dead); c.runningIn = s ? s.name : registry.find((r) => r.sessionId === c.id)?.name || null; }
          return send(res, 200, list);
        }
        case "GET /api/peek": return send(res, 200, { lines: await peek(url.searchParams.get("name"), Number(url.searchParams.get("lines") || 40)) });
        case "GET /api/stream": {
          // Server-sent screen: capture-pane twice a second, push only when it changed.
          const name = url.searchParams.get("name");
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          let last = null;
          const tick = async () => { try { const text = (await peek(name, 45)).join("\n"); if (text !== last) { last = text; res.write(`data: ${JSON.stringify(text)}\n\n`); } } catch (e) { res.write(`event: gone\ndata: ${JSON.stringify(e.message)}\n\n`); clearInterval(t); res.end(); } };
          const t = setInterval(tick, 500); tick();
          req.on("close", () => clearInterval(t));
          return;
        }
        case "POST /api/hook": onHook(body); return send(res, 200, { ok: true });
        case "POST /api/send": await sendKeys(body.name, body); return send(res, 200, { ok: true });
        case "POST /api/start": return send(res, 200, await startSession(body));
        case "POST /api/kill": await killSession(body.name); return send(res, 200, { ok: true });
        case "POST /api/restart": return send(res, 200, await restartSession(body.name));
        case "POST /api/wrapup": await wrapUp(body.name, body.prompt); return send(res, 200, { ok: true });
        case "POST /api/close-idle": {
          const st = await state(); const closed = [];
          for (const s of st.sessions) if (s.stale && s.managed) { await killSession(s.name, "idle-cull"); closed.push(s.name); }
          return send(res, 200, { closed });
        }
        case "POST /api/screen/migrate": {
          const screens = (await state()).screens; const sc = screens.find((s) => s.name === body.name);
          if (!sc) throw new Error("No such screen");
          if (sc.attached) throw new Error("That screen is attached somewhere. Detach it first (Ctrl-A D), then move it.");
          if (!sc.path || !sc.sessionId) throw new Error("No Claude session found inside that screen");
          await run("screen", ["-S", `${sc.pid}.${sc.name}`, "-X", "quit"]);
          await sleep(1500);
          event("screen-migrated", { screen: sc.name, path: sc.path });
          return send(res, 200, await startSession({ path: sc.path, sessionId: sc.sessionId, origin: "migrated" }));
        }
        case "POST /api/startup/run": return send(res, 200, await runStartup("button"));
        case "GET /api/usage": return send(res, 200, await usageReport());
        case "POST /api/usage/reindex": reindexUsage(); return send(res, 200, { ok: true });
        case "GET /api/events": return send(res, 200, readEvents(Number(url.searchParams.get("limit") || 80)));
        case "PUT /api/config": {
          if (Array.isArray(body.startup)) config.startup = body.startup.filter((e) => e && typeof e.path === "string").map((e) => ({ path: e.path, resume: e.resume || "last", ...(e.permissionMode ? { permissionMode: e.permissionMode } : {}) }));
          if (Array.isArray(body.pinned)) config.pinned = body.pinned.filter((p) => p && typeof p.path === "string").map((p) => ({ path: p.path, label: slug(p.label || path.basename(p.path)) }));
          if (body.defaults && typeof body.defaults === "object") config.defaults = { ...config.defaults, ...body.defaults };
          for (const k of ["notifyOnExit", "autoTrust", "autoResume", "accountLimits"]) if (typeof body[k] === "boolean") { config[k] = body[k]; if (k === "accountLimits") limitsCache = { at: 0, value: null, error: null }; }
          if (Number(body.idleHours) > 0) config.idleHours = Number(body.idleHours);
          if (typeof body.wrapPrompt === "string" && body.wrapPrompt.trim()) config.wrapPrompt = body.wrapPrompt.trim();
          saveConfig();
          return send(res, 200, await state());
        }
        case "GET /api/skills": return send(res, 200, await skillList());
        case "POST /api/skill/mode": setSkillMode(String(body.name), String(body.mode)); return send(res, 200, await skillList());
        case "POST /api/skill/group": {
          config.skillGroups = { ...(config.skillGroups || {}) };
          if (body.group) config.skillGroups[String(body.name)] = String(body.group) === "yours" ? "yours" : "installed";
          else delete config.skillGroups[String(body.name)];
          saveConfig();
          return send(res, 200, await skillList());
        }
        case "POST /api/plugin/toggle": setPluginEnabled(String(body.id), body.enabled); return send(res, 200, await skillList());
        case "GET /api/skill/file": {
          const file = url.searchParams.get("file");
          if (!skillFileOk(file)) throw new Error("Not a skill file");
          return send(res, 200, { file, text: await fsp.readFile(file, "utf8") });
        }
        case "PUT /api/skill/description": writeDescription(String(body.file), String(body.description)); return send(res, 200, await skillList());
        case "POST /api/skill/new": return send(res, 200, newSkill(body));
        case "POST /api/project": {
          // A new project: a directory under the parent (home by default), git init unless told
          // not to, pinned under its own name, ready for the first session.
          const name = String(body.name || "").trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error("Name: letters, digits, dots, dashes, underscores");
          const parent = String(body.parent || HOME).replace(/^~/, HOME);
          if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`No such folder: ${parent}`);
          const dir = path.join(parent, name);
          if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
          fs.mkdirSync(dir);
          if (body.git !== false) await run("git", ["init", "-q", dir]);
          if (!config.pinned.some((p) => p.path === dir)) { config.pinned.push({ path: dir, label: slug(name) }); saveConfig(); }
          knownCache.at = 0;
          event("project", { path: dir, git: body.git !== false });
          return send(res, 200, { path: dir, label: slug(name) });
        }
        case "GET /api/dir-check": { const p = url.searchParams.get("path") || ""; return send(res, 200, { ok: p.startsWith("/") && fs.existsSync(p) && fs.statSync(p).isDirectory(), path: p }); }
        default: return send(res, 404, { error: "no such route" });
      }
    }
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(ROOT, "public", file);
    if (!full.startsWith(path.join(ROOT, "public"))) return send(res, 403, "no", "text/plain");
    const data = await fsp.readFile(full).catch(() => null);
    if (!data) return send(res, 404, "not found", "text/plain");
    return send(res, 200, data, MIME[path.extname(full)] || "application/octet-stream");
  } catch (e) {
    log(`${req.method} ${url.pathname} failed:`, (e.stderr || e.message || "").trim());
    return send(res, 400, { error: String(e.stderr || e.message).trim() });
  }
});
// WebSocket upgrade for the terminal, piped straight through to ttyd.
server.on("upgrade", (req, socket, head) => {
  if (!authed(req, new URL(req.url, "http://x"))) return socket.destroy();
  if (!req.url.startsWith("/term")) return socket.destroy();
  const up = http.request({ host: "127.0.0.1", port: TERM_PORT, method: req.method, path: req.url, headers: req.headers });
  up.on("upgrade", (r, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${r.statusCode} ${r.statusMessage}`]; for (const [k, v] of Object.entries(r.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n"); if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket); socket.pipe(upSocket);
    upSocket.on("error", () => socket.destroy()); socket.on("error", () => upSocket.destroy());
  });
  up.on("error", () => socket.destroy());
  up.end(head);
});

server.listen(PORT, BIND, async () => {
  log(`claude-sessions on ${BIND}:${PORT}, tmux socket ${SOCKET}, terminal via :${TERM_PORT}`);
  if (!config.token) log("NO TOKEN SET: anything that can reach this port can run commands as you. Trusted networks only, or set \"token\" in data/config.json.");
  await maybeRestoreAtBoot().catch((e) => log("boot restore failed:", e.message));
  setInterval(watch, 15_000); watch();
  setInterval(probeTerm, 30_000); probeTerm();
  setTimeout(reindexUsage, 3000); setInterval(reindexUsage, 120_000);
});
