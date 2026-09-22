# Claude sessions: how every element behaves

Written 16 Sep 2026. The rules come from the Howff design notes (venue-finder DESIGN.md and its
memory): one primary action per screen, progressive disclosure for the rest, motion that confirms
rather than decorates, ease-out timing and never a bounce. Reduced-motion is deliberately not supported here;
add it if you need it. Timings: sheets
about 300 ms on `cubic-bezier(0.2, 0.8, 0.2, 1)`, small state changes 120 to 150 ms.

## Structure

Three tabs on a bottom dock, each its own screen, remembered across reloads and reachable by URL
hash (`#sessions`, `#startup`, `#settings`) so the browser back button works.

| Tab | Owns | Primary action |
|---|---|---|
| Sessions | what is running now | New session |
| Startup | what comes back after a reboot | Add |
| Settings | defaults, pinned directories, old screens, how to attach | none, it is a form |

Sheets carry every flow that needs input. Nothing that needs a decision is inline on a tab.

## The dock

- Fixed at the bottom, above the safe area, three equal buttons with icon and label.
- Tapping switches tab with a 160 ms crossfade. The old screen fades out, the new one fades in
  with a 6 px upward drift. No slide, tabs are peers, not a stack.
- Each tab keeps its own scroll position while you are on another.
- Tapping the tab you are already on scrolls it to the top.
- Active tab is tinted sodium orange. The active state changes with a 140 ms colour fade.

## Sheets

One component, used for every flow. It opens from the bottom.

- Open: backdrop fades in over 200 ms while the panel slides up over 320 ms, ease-out. Body scroll is
  locked while it is open (fixed-position technique, so iOS Safari does not scroll behind it),
  and the scroll position is restored to the pixel on close.
- Close: panel slides down over 240 ms, backdrop fades over the same time, then it unmounts. Closing
  returns focus to the element that opened it.
- Swipe down to dismiss: the panel follows the finger 1:1 from a drag on the grabber or header,
  or on the body when the body is scrolled to the top. Release past 70 px, or a flick faster than
  0.5 px per ms, dismisses. Otherwise it returns to place over 200 ms ease-out, no spring.
  While dragging, the backdrop dims in proportion to how far down the panel is.
- Tapping the backdrop closes. Escape closes. The grabber is a visible cue, 36 by 5 px.
- Height is content, capped at 88 vh, and the body scrolls inside the panel. A sticky footer holds
  the one primary button so it is never below the fold.
- Multi-step flows push steps inside the same sheet: the next step slides in from the right over
  260 ms, and Back slides it out again. The sheet does not close and reopen between steps.

## Sessions tab

- Header: title, host name, and a count of running sessions.
- New session: the single primary button, full width, sodium orange, at the top. It opens the
  directory sheet.
- Session cards, one per tmux session, sorted by name. The whole card is a button and opens the
  session sheet. Pressed state: scale 0.98 over 100 ms.
  - Name in monospace, the conversation title under it, the path and uptime under that.
  - Status pill on the right: green "active" when the screen changed in the last 20 s, grey
    "idle Nm" otherwise, red "exited N" when the process has gone. Pill colour changes crossfade
    over 140 ms.
  - A new card enters with a 240 ms fade and 8 px rise. A card whose session ended and was closed
    leaves in two stages: content fades over 150 ms, then the height collapses over 200 ms.
  - Cards are updated in place every 10 s and the moment the app comes back to the foreground.
    They are never rebuilt wholesale, so nothing flickers on refresh.
- Empty state: one line and the same New session button, nothing else.
- If the server cannot be reached, a banner at the top says so with a Retry button. It replaces
  the earlier behaviour of a toast every 10 s.

## The directory sheet (New session, step 1)

- Pinned directories as a two-column grid of tiles, label in monospace, conversation count and
  running count under it. Tapping a tile pushes step 2.
- Under the grid, "Everything Claude has used" is a collapsed disclosure listing every other
  directory, most recently used first. Opening it does not close the pinned grid.
- "Other path" at the bottom is a text field with a Continue button. It validates on the server
  and shows the error inline under the field, not as a toast.
- Nothing is auto-focused, so the keyboard does not push the sheet around on open.

## The conversation sheet (New session, step 2)

- Header: the label, the path, and "already running: rota-1" when applicable. Back arrow on the
  left.
- Fresh conversation is the first option and is ticked by default. Under it, the directory's
  conversations, most recent first, each a radio row with Claude's title, when it was last used,
  its size, and the last prompt in one clipped line. A conversation already running is greyed with
  "running in rota-1" and cannot be picked.
- Twelve are shown, then "Show N older" appends the rest in place.
- Options is a collapsed disclosure: permission mode (segmented control) and the name used for
  tmux and Remote Control. Most starts never open it.
- Footer: one Start button. While starting it shows a spinner and reads "Starting", and cannot be
  tapped twice. On success the sheet closes, the new card enters highlighted, and a toast names
  it. On failure the error appears inline above the footer and the button is re-enabled.

## The session sheet (tap a card)

- Header: name, status pill, conversation title, path, uptime, permission mode.
- Screen: the last 40 lines of the pane in monospace on a black block, kept scrolled to the
  bottom, refreshed every 3 s while the sheet is open. Lines that change do not flash.
- Keys under the screen: Up, Down, Enter, Esc, Ctrl-C, each a 44 px target. A text line with Send.
  Every send refreshes the screen 700 ms later so you see the result. When the screen shows
  Claude's trust prompt, a "Trust this folder" button appears first in the row.
- Actions: Copy attach (copies `cl name`, toast confirms), Restart, Kill. Kill and Restart use an
  inline two-step confirm (the button turns into "Sure? Yes / No" for 4 s) rather than a browser
  dialog.
- An exited session shows a red banner with the exit code and two actions: Start again on the same
  conversation, or Close to drop the pane.

## Startup tab

- Header and a short line explaining that these come back after a reboot, resumed where they
  left off unless set to fresh.
- Add is the primary button. It opens the directory sheet in "startup" mode: picking a
  directory adds it with "resume last" and closes.
- One card per entry: label, path, a two-way segmented control (Resume, Fresh) that saves on
  change with a toast, and a Remove control with the same inline confirm as Kill.
- Run now is a secondary button at the bottom, disabled when the set is empty. Its result is a
  toast listing what started and what was skipped.
- Empty state: one line and the Add button.

## Settings tab

- Default permission mode: segmented control, saves on change.
- Discord ping when a session dies: an iOS-style switch, saves on change.
- Pinned directories: list with label editable inline (tap the label, edit, blur saves) and an
  Unpin control. The order here is the order of the tiles.
- Old screen sessions: read-only list with Copy attach, and one line saying they stay until
  closed.
- How to attach: a help card with the `cl` commands and the tmux keys.

## Everywhere

- Touch targets are at least 44 px tall. Tap highlight is zeroed and `:focus-visible` draws a 2 px
  sodium ring instead.
- Buttons have a pressed state (scale 0.97, 100 ms). Disabled buttons sit at 45 % opacity and
  ignore taps.
- Toasts appear above the dock, slide up 8 px and fade in over 160 ms, stay 2.2 s (5 s for errors,
  which get a red edge), and fade out. One at a time, a new one replaces the old.
- Every write shows its result: a toast on success, an inline message on failure.
- Refresh happens on a 10 s timer, on returning to the foreground, and after every action.

## The look (added the same night)

Palette is the Claude app's: warm dark greys (`#1f1e1d` ground, `#2a2927` plates) with Claude's
orange `#d97757`, ink `#f5f3ee`, dim `#a39f96`.

Every pressable thing is THE KEY from the QuizPoker phone: a face, a side seen below it (the lip,
4 px on buttons, 5 px on the big primary, 3 px on cards, tiles and small buttons), a 1 px light
along the top edge, and a soft shadow on the ground. Pressing drops the face by the lip over 80 ms
and closes the shadow, so the tap reads as the thing going down. No outlines anywhere.

A well is where a key is not: text fields, the segmented track, the switch track, the live
terminal and the grabber are recesses cut into the plate (inset shadow). The active segment is a
raised key sitting in the well. The dock's active tab is a well with the orange icon in it.

App shell: the document never scrolls. `#screens` is the one scroller, the dock and sheet are fixed
siblings, so nothing jumps in standalone mode on iOS when a tab is short or the page rubber-bands.

## Second pass (same night): what the launcher knows now

- Sessions tab header shows the count waiting on you as a badge, mirrored on the dock and the
  app icon. A card whose session needs you gets an orange ring and a blinking "your turn" or
  "needs permission" pill. Working sessions show a steady green "working" from Claude's own
  registry, not a guess from screen activity.
- Memory card under New session: the unit's total against the 8 GB rail, the four biggest
  sessions, red copy past 85 percent.
- The session sheet holds a real terminal (xterm.js over ttyd's websocket, mounted in the page,
  no iframe). Touch inside it scrolls the terminal, not the sheet. The key row is the set a phone keyboard hides: Esc, Tab, Shift-Tab, arrows, Enter, Ctrl-C, and 1 2 3 for permission menus.
  Actions: Open in Claude (deep link to the Remote Control conversation), Copy attach, Wrap up,
  Restart, Kill.
- New session step 2 has a First message field. It is typed into the session once Claude's
  prompt box is up, after the trust prompt (answered automatically when the setting is on) and
  after the Remote Control card is dismissed.
- Usage tab: live account limits (5-hour and 7-day bars with reset times), then tokens by
  conversation for the current 5-hour window, today, or the week.
- Settings gained: trust new folders, resume after a memory-rail kill, idle-after hours, the
  wrap-up message, old screens with their conversation titles and a Move to tmux action, and
  the event log.

## Skills tab (17 Sep)

Five tabs now. Skills lists every skill Claude can see, grouped Yours, Installed, Anthropic, with
a search box and a cost card at the top: how many characters of skill descriptions a new session
loads, and what share that is of everything installed. The bar measures against the installed
total, not an invented ceiling, so switching something off visibly shrinks it.

A row shows name, description clipped to two lines, its cost in characters, and tags for the
project or plugin it comes from and its mode when that is not "on". Tapping opens a sheet with a
four-way mode control (On, Name only, Slash only, Off), the plugin switch when the skill came from
a plugin, a Yours/Installed group override, the description as an editable field for skills whose
files we own, and the SKILL.md itself behind a disclosure. Anthropic's bundled skills have no file,
so they list and switch but do not edit. Every change says it applies to new sessions.

New skill writes a correct SKILL.md into the user folder or a pinned project.

## Keeping Claude Code current (22 Sep)

A session keeps the binary it started with. That is why a new model looks unavailable in
everything already running, and updating alone does not fix it.

A card on Sessions when any session is behind: how many, the version they are on, the version
installed, and two buttons. **Roll** restarts each one on the same conversation, which the resume
path already does losslessly, and it refuses to touch a session that is busy or sitting on a
permission prompt. **Check for an update** runs the updater and reports the version change.

The session sheet shows that session's own version, and says when a newer one is available.

The new-model card's primary action is **Use for new sessions**, which writes Claude Code's own
model setting. A copy button is not an action.

## Doing it unattended (22 Sep)

One switch in Settings, off by default because it restarts live sessions. When on, the updater
runs daily and every session is expected to be on the installed version.

It is a standing check rather than a one-shot, which is what makes queueing work: a session that
is busy when the update lands is skipped and picked up on a later pass. The card says which, in
its own line in the accent colour, because "updates when it finishes" is the actionable part and
the single-line meta above it truncates.

It refuses to roll a session that is busy, attached to a terminal, waiting on you, quiet for less
than the threshold, or running a shell command. That last one matters and status will not tell
you: idle means the model is not generating, not that nothing is happening. A Claude with nothing
running has only its MCP servers as children, so any other shell child is work in flight, and
rolling would kill it.

## New model releases (22 Sep)

A card at the top of Sessions when a model appears that has not been seen before: its name in the
accent colour, the id, the release date, a copy button and a dismiss. It is the only thing on that
screen with an accent edge, because a release is rare enough to earn it.

The source is Anthropic's own model list, read with the OAuth token Claude Code already saved, so
it is opt-in in Settings for the same reason the usage limits are. Checked six-hourly. The first
run records what already exists silently, because nobody wants a dozen notifications for models
that shipped months ago. A release also goes to Discord.
