# Claude Sessions

A self-hosted manager for [Claude Code](https://claude.com/claude-code) sessions on your own
machine. Open a page on your phone, tap a directory, and a Claude session starts there in tmux
with Remote Control on. It comes back by itself after a reboot.

It exists because the alternative was: open a terminal app, start a screen session, `cd` to the
project, run `claude`, turn on remote control, and do that again for every project, every time the
machine restarted. And `screen` cannot scroll on a phone keyboard without a chord.

![The sessions list, a running session, and the usage tab](docs/screens.jpg)

## What it does

**Sessions.** One tap starts Claude in any directory, resuming a previous conversation or starting
fresh. Sessions are named `project-1`, `project-2`, and the tmux name, the Remote Control name and
Claude's own session name all match. Each card shows whether Claude is working, waiting for you, or
gone, read from Claude Code's own session registry rather than guessed.

**A real terminal.** The session sheet holds the live tmux pane, with a scrolling strip of the keys
a phone keyboard hides: Esc, Tab, Shift-Tab, arrows, Ctrl-C, and the digits that answer a
permission prompt. Drag to scroll the scrollback. Or open the same conversation in the Claude
mobile app with one tap.

**Survives a reboot.** A startup set you choose comes back at boot, each entry resumed where it
left off or started fresh. No terminal, no typing.

**Watches the box.** A memory meter against the cgroup rail every session shares, so one leaking
session cannot take the machine down quietly. A session killed by the rail is resumed once,
automatically. Idle sessions are offered up for closing.

**Usage.** Your live 5-hour and 7-day limits, then output tokens attributed per conversation, so
you can see which piece of work is spending the window.

**Skills.** Every skill Claude can see, grouped into yours, installed, and Anthropic's, with what
each one costs your context in characters. A four-way switch per skill writes Claude Code's own
`skillOverrides`, so you can stop a 20-skill suite advertising itself in every session while
keeping its slash commands. Turning one suite to slash-only cut 11,501 characters from every
session on the machine this was built for.

**Scriptable.** `cs` drives all of it from a shell, and the bundled skill teaches Claude to use it,
so you can say "start a session in the api repo and tell it to fix the failing test" to a session
you already have open.

## Requirements

Linux with `systemd --user`, `node` 20+, `tmux`, `jq`, `git`, and `claude` on your PATH.
Tested on Ubuntu 24.04. macOS is not supported yet: the memory meter and the process walk read
`/proc`.

## Install

```bash
git clone https://github.com/YOU/claude-sessions.git ~/claude-sessions
cd ~/claude-sessions
./install.sh
```

It installs two `systemd --user` services, links `cl` and `cs` into `~/.local/bin`, downloads
[ttyd](https://github.com/tsl0922/ttyd) for the in-page terminal (skip with `--no-terminal`), and
installs the `claude-sessions` skill. Everything lands in your home directory; nothing needs root.
Then open `http://<your-machine>:8795`.

Two things it will tell you about if they are missing:

- `sudo loginctl enable-linger $USER` so sessions survive logout and reboot.
- `set -g mouse on` in `~/.tmux.conf`, which is what lets a phone scroll a pane.

Remove it with `./install.sh --uninstall`. Your running sessions and your data are left alone.

## Security

**This app starts processes and types into them. Anything that can reach its port can run commands
as you.** There is no sandbox, and Claude sessions it starts may be running in a permissive
permission mode.

- Keep it on a trusted network. A LAN name behind a reverse proxy, or a VPN, is the intended shape.
- **Never put it behind a public tunnel or port-forward** without authentication in front of it.
- For anything less than fully trusted, set `"token": "some-long-random-string"` in
  `data/config.json` (or the `CLAUDE_SESSIONS_TOKEN` environment variable). Every request then
  needs it, as `?token=` once per device, an `X-Auth-Token` header, or the cookie the page sets.
- `BIND=127.0.0.1` in the unit restricts it to the machine itself if you would rather reach it
  over SSH forwarding.

The usage panel reads your existing Claude Code OAuth token from `~/.claude/.credentials.json` and
calls the same account endpoint Claude Code's own `/usage` uses. It is read locally, sent only to
Anthropic, and never stored or logged by this app. That endpoint is undocumented, so treat the
panel as a convenience that may stop working; nothing else depends on it.

## Running a second instance

Every path and port is overridable, so a test or demo instance can run beside the real one without
touching it:

```bash
DATA_DIR=/tmp/demo TMUX_SOCKET=demo PORT=8796 TERM_PORT=7682 node server.mjs
```

Give it its own ttyd (`TMUX_SOCKET=demo ttyd -p 7682 -i lo -W -a -b /term ~/.local/bin/claude-term-attach`)
or leave the terminal out.

## How it works

```
browser ──► server.mjs (node, no dependencies) ──► tmux -L claude ──► claude --remote-control
                │
                ├── ~/.claude/sessions/*.json     live status, names, Remote Control ids
                ├── ~/.claude/projects/**/*.jsonl conversation titles and token usage
                ├── ~/.claude/settings.json       hooks, per-skill switches
                └── ttyd on 127.0.0.1:7681        the terminal, proxied under /term
```

Sessions live on their own tmux socket (`-L claude`), inside the launcher's systemd cgroup, so the
memory rail covers them and `tmux ls` never shows them by accident. `KillMode=process` means
restarting the launcher leaves every session running.

The installer adds four Claude Code hooks (`Notification`, `Stop`, `UserPromptSubmit`,
`SessionEnd`) pointing at `http://127.0.0.1:8795/api/hook`, which is how the page knows the moment
a session needs you. They are plain HTTP hooks in your `settings.json` and can be removed by hand.

## The `cs` command

```
cs list                       what is running, with status and title
cs dirs                       pinned directories
cs new <name>                 create a project folder, git init, pin it
cs start <dir> [-r last|<id>] [-m "first message"] [-p mode]
cs peek <name> [lines]        what is on its screen
cs send <name> "text"         type a line and press Enter
cs keys <name> Escape         a key: Enter Escape Up Down Tab BTab C-c
cs wrapup <name>              send the wrap-up prompt, close when Claude finishes
cs restart|kill <name>
cs skills [search]            every skill, grouped, with its context cost
cs skill <name> <mode>        on | name-only | user-invocable-only | off
cs usage                      account limits and the heaviest conversations
cs events [n]                 the launcher's log
```

`cs json <cmd>` prints raw JSON for any of them.

## Design notes

`UX.md` is the written spec for how every element behaves and why: the sheet, its swipe dismissal,
the tactile key styling, the terminal's touch scrolling, and the traps each one cost. Worth reading
before changing the front end.

## Licence

MIT. Bundles [xterm.js](https://github.com/xtermjs/xterm.js) (MIT) in `public/vendor`.
Not affiliated with Anthropic.
