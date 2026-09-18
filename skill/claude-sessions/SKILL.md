---
name: claude-sessions
description: Start, watch, steer and stop other Claude Code sessions on this box through the launcher at claude.home (~/claude-sessions). Use when the user says "start a claude session in X", "open a session for the api repo", "spin up claude in <project> and tell it to…", "what sessions are running", "kill/wrap up that session", or asks about their Claude usage limits.
---

# Claude sessions

The launcher (`~/claude-sessions`, user service `claude-sessions.service`, page at http://claude.home)
runs Claude Code sessions in tmux on socket `claude`, one per `<label>-<n>`, each with Remote Control
on so the user can pick it up on their phone. Everything it can do is on the `cs` command
(`~/.local/bin/cs`). Use that; never start a bare `claude` in a screen or tmux by hand.

## The one-liners

```bash
cs list                                  # what is running, with status and title
cs dirs                                  # pinned directories: label -> path
cs start rota                            # fresh conversation in the rota project
cs start rota -r last                    # resume the most recent conversation there
cs start ~/api-server -m "run the test suite and report what fails"   # first message typed in for you
cs start api-server -r 25436b2b-c5a5-4dea-bd0c-60dfcd39b6c8          # resume a specific conversation
cs new my-idea                           # new project folder ~/my-idea, git init, pinned; then cs start my-idea
cs convos rota                           # conversation ids and titles for a directory
cs peek rota-2                           # the last 40 lines of its screen
cs send rota-2 "also check the tips page"   # type a line, press Enter
cs keys rota-2 Escape                    # a key: Enter Escape Up Down Tab BTab C-c
cs wrapup rota-2                         # sends /handoff, closes when Claude finishes
cs kill rota-2
cs skills [search]                       # every skill, grouped yours/installed/anthropic, with context cost
cs skill hyperframes user-invocable-only # on | name-only | user-invocable-only | off
cs usage                                 # account limits and the heaviest conversations
```

`cs json <cmd>` prints raw JSON for any of them.

## How to do it right

- **Directory first.** `cs dirs` gives the labels. A label or a full path both work. The label becomes the session name prefix, so `cs start rota` gives
  `rota-1`, then `rota-2`, and so on. Tell the user the name it came back with: that is what
  shows on their phone and what `cl rota-2` attaches to.
- **Resume or fresh.** Fresh is the default. `-r last` resumes the newest conversation in that
  directory. A conversation already open elsewhere is refused with a clear error; do not retry.
- **First message.** Prefer `-m` over `cs send` right after start: the launcher waits for Claude's
  prompt box, answers the trust prompt, and dismisses the Remote Control card before typing.
  A `cs send` in the first few seconds can be swallowed by that card.
- **Watch it.** `cs list` status is `working`, `your turn`, `idle` or `exited N`. `cs peek` shows
  the screen. Wait with `sleep`, do not poll faster than every few seconds.
- **Ending.** `cs wrapup <name>` runs the session's handoff and closes it once Claude answers,
  which is the right way to end a project session. `cs kill` just kills it; the conversation
  stays on disk and can be resumed later.
- **Never** kill or wrap up a session you did not start unless the user asked for that one by name.
  The session you are talking in is one of them.
- **Skills.** `cs skills` shows what every skill costs a session in characters; `cs skill <name> <mode>`
  changes it by writing `skillOverrides` in `~/.claude/settings.json`. It applies to sessions started
  afterwards, never the running one. Do not switch a skill off unless the user asked.
- **Limits.** `cs usage` reads the real 5-hour and 7-day percentages from the account. If the user asks
  how much usage is left, this is the answer, not a guess.

## If it fails

`cs` talks to `http://127.0.0.1:8795`. If that refuses, `systemctl --user status claude-sessions`
and its log at `~/claude-sessions/server.log`. The tmux sessions survive a launcher restart.
