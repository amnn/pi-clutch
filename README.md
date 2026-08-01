# Pi Edit Clutch

A [Pi](https://github.com/earendil-works/pi) extension that switches between
normal editing and an exploratory, no-edit mode.

The clutch starts **engaged**. Press **M-e** to toggle it. The editor's top
border is unchanged while engaged and separates while disengaged:

```text
Engaged       ────────────
Disengaged    ───────┤  ├─
```

The indicator inherits the existing border styling and does not add a footer
row. Each toggle also shows a transient notification naming the new state.

## Behavior

### Engaged

Pi behaves normally. The model may use `edit` and `write` when appropriate to
the request.

### Disengaged

The extension:

- tells the model to explore, explain, ask questions, compare options, and plan
  instead of implementing;
- appends a short hidden reminder at the end of every outgoing model context;
- blocks `edit` and `write` calls before execution; and
- renders separated plates near the right edge of the editor's top border.

The renderer replaces the last exact sequence of six cells using the editor's
current horizontal-border style with `─┤  ├─`. Differently styled sections,
scroll labels, and other border content remain untouched. If there is no exact
match, it leaves the border unchanged.

## Context protocol

The first time the clutch is disengaged, the extension stores one hidden,
state-neutral definition of the protocol in the session. It does so immediately
when Pi is idle. If a response is in progress, the entire toggle waits until the
agent has fully settled, so neither the definition nor a state change can steer
the active run. The definition explains that:

- a trailing hidden message wrapped in `<clutch disengaged>...</clutch>` means
  the clutch is disengaged for that model request;
- absence of those tags means the clutch is engaged; and
- older conversation text, prior assistant behavior, and tool availability are
  not authoritative state signals.

While disengaged, the marker is appended ephemerally to the end of every
outgoing model context. This leaves the assembled conversation as an unchanged
prefix, maximising KV-cache reuse. The marker is sent to the model but is not
written to session history and does not accumulate. No state message is added
while engaged.

The persistent definition is hidden from the TUI but remains in the session
JSONL, so it will be restored on reload or resume.

## State persistence

Clutch state is stored in branch-local custom session entries that are not sent
to the model. It survives reloads, resumes, forks, and session-tree navigation.
Pressing M-e during an active response queues the whole toggle: state, border,
context behavior, persistence, and notification all change together when the
agent settles. Additional presses before settlement cancel in pairs. A session
with no saved state starts engaged.

## Installation

Install from this repo:

```sh
pi install git:github.com/amnn/pi-clutch
```

Or try the extension directly without installing it:

```sh
pi -e ./index.ts
```

After changing an installed extension, run `/reload` in Pi.

### macOS terminals

`M-e` is usually **Opt+E** on macOS. Configure the terminal's Option key to
send Alt/Meta (often described as “Esc+”) rather than using Opt+E as the
acute-accent dead key.

## Scope and limitations

This is not a sandbox, it provides behavioural guidelines, and a block for
`edit` and `write` calls. `bash` remains available and is not inspected or
filtered; custom tools, MCP servers, and other extensions may still mutate
files.

Clutch decorates the editor factory that is active when it loads, forwarding all
other behavior to that editor. An extension that replaces the editor after
Clutch loads will replace the decoration too.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run typecheck
npm run check
```

The tests cover shortcut registration, fixed-width exact-style border
rendering, editor delegation, state persistence, hidden context injection,
reload restoration, and `edit`/`write` blocking.
