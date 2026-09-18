#!/usr/bin/env bash
# Install the Claude session launcher for the CURRENT user.
#
#   ./install.sh                 install and start
#   ./install.sh --no-terminal   skip the in-page terminal (no ttyd download)
#   ./install.sh --uninstall     stop and remove the services (leaves your data)
#
# It writes two systemd --user services, links `cl` and `cs` into ~/.local/bin, and installs the
# claude-sessions skill so other Claude sessions can drive it. Nothing is written outside your
# home directory, and nothing needs root.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS="$HOME/.config/systemd/user"
BIN="$HOME/.local/bin"
SKILLS="$HOME/.claude/skills"
PORT="${PORT:-8795}"
TERM_PORT="${TERM_PORT:-7681}"
say() { printf '\033[38;5;209m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[38;5;209m!! \033[0m %s\n' "$*" >&2; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now claude-sessions.service claude-term.service 2>/dev/null || true
  rm -f "$UNITS/claude-sessions.service" "$UNITS/claude-term.service" "$BIN/cl" "$BIN/cs" "$BIN/claude-term-attach"
  rm -rf "$UNITS/claude-sessions.service.d" "$SKILLS/claude-sessions"
  node - "$HOME/.claude/settings.json" <<'NODE' || true
const fs = require("fs"), file = process.argv[2];
let s; try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = s.hooks[ev].map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.url || "").includes("/api/hook")) })).filter((g) => g.hooks.length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
NODE
  systemctl --user daemon-reload
  say "Removed. Your tmux sessions are still running (cl lists them); data/ is untouched."
  exit 0
fi

# --- checks ---------------------------------------------------------------
for c in node tmux jq git; do command -v "$c" >/dev/null || { warn "missing: $c"; MISSING=1; }; done
[ "${MISSING:-}" ] && { warn "install the above, then run this again"; exit 1; }
command -v claude >/dev/null || warn "claude is not on PATH; the launcher will start sessions that immediately fail"
node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { warn "node 20 or newer is needed"; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || { warn "no systemd --user session here (a container?); run 'node server.mjs' yourself instead"; exit 1; }

mkdir -p "$UNITS" "$BIN" "$SKILLS" "$HERE/data"
[ -f "$HERE/data/config.json" ] || { cp "$HERE/data/config.example.json" "$HERE/data/config.json"; say "wrote data/config.json"; }

# --- the in-page terminal (optional) --------------------------------------
WANT_TERM=1; [ "${1:-}" = "--no-terminal" ] && WANT_TERM=0
if [ $WANT_TERM = 1 ] && [ ! -x "$BIN/ttyd" ] && ! command -v ttyd >/dev/null; then
  say "fetching ttyd (the web terminal)"
  arch=$(uname -m)
  curl -fsSL -o "$BIN/ttyd" "https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.${arch}" \
    && chmod +x "$BIN/ttyd" || { warn "ttyd download failed; the terminal will be a read-only screen"; WANT_TERM=0; }
fi
TTYD="$(command -v ttyd || echo "$BIN/ttyd")"

# --- files ----------------------------------------------------------------
install -m 755 "$HERE/bin/cl" "$BIN/cl"
install -m 755 "$HERE/bin/cs" "$BIN/cs"
install -m 755 "$HERE/bin/claude-term-attach" "$BIN/claude-term-attach"
mkdir -p "$SKILLS/claude-sessions"; cp "$HERE/skill/claude-sessions/SKILL.md" "$SKILLS/claude-sessions/SKILL.md"

subst() { sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER|g" -e "s|__DIR__|$HERE|g" -e "s|__PORT__|$PORT|g" -e "s|__TERM_PORT__|$TERM_PORT|g" -e "s|__TTYD__|$TTYD|g" -e "s|__SOCKET__|${TMUX_SOCKET:-claude}|g" "$1"; }
subst "$HERE/systemd/claude-sessions.service" > "$UNITS/claude-sessions.service"
mkdir -p "$UNITS/claude-sessions.service.d"; subst "$HERE/systemd/memory.conf" > "$UNITS/claude-sessions.service.d/memory.conf"
[ $WANT_TERM = 1 ] && subst "$HERE/systemd/claude-term.service" > "$UNITS/claude-term.service"

# tmux mouse mode is the whole reason this beats screen on a phone, but never clobber a real config.
if [ ! -f "$HOME/.tmux.conf" ]; then
  printf '# Written by the Claude session launcher. Mouse on is what lets a phone scroll by swiping.\nset -g mouse on\nset -g history-limit 50000\nset -sg escape-time 10\n' > "$HOME/.tmux.conf"
  say "wrote ~/.tmux.conf (mouse on)"
elif ! grep -q 'mouse on' "$HOME/.tmux.conf"; then
  warn "your ~/.tmux.conf has no 'set -g mouse on'; add it or phone scrolling will not work"
fi

# Sessions outlive the login shell only if lingering is on.
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes || warn "run: sudo loginctl enable-linger $USER   (so sessions survive logout and reboot)"

# --- hooks -----------------------------------------------------------------
# Four HTTP hooks tell the page the moment a session needs you. Merged into your settings, never
# replacing hooks you already have, and removable by hand afterwards.
node - "$HOME/.claude/settings.json" "$PORT" <<'NODE'
const fs = require("fs"), [file, port] = process.argv.slice(2);
let s = {};
try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (fs.existsSync(file)) { console.error("settings.json is not valid JSON; leaving hooks alone"); process.exit(0); } }
const url = `http://127.0.0.1:${port}/api/hook`;
const hook = { type: "http", url, timeout: 3 };
const has = (arr) => (arr || []).some((g) => (g.hooks || []).some((h) => h.url === url));
s.hooks = s.hooks || {};
for (const [ev, matcher] of [["Notification", "permission_prompt|idle_prompt"], ["Stop", null], ["UserPromptSubmit", null], ["SessionEnd", null]]) {
  s.hooks[ev] = s.hooks[ev] || [];
  if (!has(s.hooks[ev])) s.hooks[ev].push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
}
fs.mkdirSync(require("path").dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
console.log("hooks installed in " + file);
NODE

systemctl --user daemon-reload
systemctl --user enable --now claude-sessions.service
[ $WANT_TERM = 1 ] && systemctl --user enable --now claude-term.service
sleep 1
systemctl --user is-active --quiet claude-sessions.service || { warn "it did not start:"; journalctl --user -u claude-sessions -n 20 --no-pager; exit 1; }

say "running at http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT  (also http://localhost:$PORT)"
say "attach from a terminal with: cl        drive it from a script with: cs"
grep -q '"token": ""' "$HERE/data/config.json" 2>/dev/null &&
  warn "no token set: anyone who can reach port $PORT can run commands as you. Keep it off the internet, or set \"token\" in data/config.json."
