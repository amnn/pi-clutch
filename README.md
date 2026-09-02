# Pi Clutch: Lightweight plan mode for the Pi coding agent

**A deliberately minimal plan mode for the
[Pi coding agent](https://github.com/earendil-works/pi).** No plan files,
approval workflow, or execution state machine: disengage the clutch when you
want Pi to explore and plan without using `edit` or `write`; engage it to return
to normal, edit-enabled operation.

If you're looking for a Claude Code/Codex-style read-only plan mode for Pi but
want something lightweight, Clutch provides the core workflow (explore and
discuss without editing) without introducing a separate planning system.

The clutch starts **engaged**. Press **M-e** to toggle it. A fixed seven-cell
excerpt near the right edge of the editor's top border shows settled and
pending states:

```text
Engaged                 ───────
Disengagement pending   ──┤⣿├──
Disengaged              ─┤   ├─
Engagement pending      ─┤⣿⣿⣿├─
```

The indicator inherits the existing border styling, keeps the rendered line at
its original width, and does not add a footer row. Toggling while Pi is active
shows a transient pending notification; settlement names the new state, and a
second press before settlement reports that the transition was cancelled.

## Installation

Install the published package from npm (recommended):

```bash
pi install npm:pi-clutch
```

Alternatively, install the latest source directly from GitHub:

```bash
pi install git:github.com/amnn/pi-clutch
```

To install from a local checkout:

```bash
git clone https://github.com/amnn/pi-clutch.git
cd pi-clutch
pnpm install
pi install .
```

Confirm the installation with `pi list`. After installing an update or changing
a local checkout, run `/reload` in Pi or restart it.

### macOS terminals

`M-e` is usually **Opt+E** on macOS. Configure the terminal's Option key to
send Alt/Meta (often described as “Esc+”) rather than using Opt+E as the
acute-accent dead key.

## Behavior

### Engaged (normal mode)

Pi behaves normally. The model may use `edit` and `write` when appropriate to
the request.

### Pending transitions

Pressing M-e during an active response changes only the pending indicator and
notification. The settled clutch behavior remains in force until the agent
settles: pending disengagement remains edit-enabled, while pending engagement
continues to inject the reminder and block `edit` and `write`.

### Disengaged (Plan mode)

The extension:

- tells the model to explore, explain, ask questions, compare options, and plan
  instead of implementing;
- appends a short hidden reminder at the end of every outgoing model context;
- blocks `edit` and `write` calls before execution; and
- renders separated plates near the right edge of the editor's top border.

The renderer replaces the last exact sequence of seven cells using the editor's
current horizontal-border style. It uses `──┤⣿├──` for pending disengagement,
`─┤   ├─` when disengaged, and `─┤⣿⣿⣿├─` for pending engagement; a settled
engaged clutch leaves the border unchanged. Differently styled sections, scroll
labels, and other border content remain untouched. If there is no exact match,
the border is unchanged.

## Context protocol

The first time the clutch is disengaged, the extension stores one hidden,
state-neutral definition of the protocol in the session. It does so immediately
when Pi is idle. If a response is in progress, the settled transition waits
until the agent has fully settled, so neither the definition nor a state change
can steer the active run. Only the pending UI changes immediately. The
definition explains that:

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
Pressing M-e during an active response queues the settled toggle. The border
immediately renders the pending state and a notification names it, while state,
context behavior, and persistence change together only when the agent settles.
Additional presses before settlement cancel in pairs, restore the settled
indicator, and show a cancellation notification. A session with no saved state
starts engaged.

## Scope and limitations

This is not a sandbox, it provides behavioural guidelines, and a block for
`edit` and `write` calls. `bash` remains available and is not inspected or
filtered; custom tools, MCP servers, and other extensions may still mutate
files.

Clutch decorates the editor factory that is active when it loads, forwarding all
other behavior to that editor. An extension that replaces the editor after
Clutch loads will replace the decoration too.

## Development

The package and its development environment require Node.js 22.19 or newer and
pnpm. The repository's `packageManager` field pins the pnpm version and lets
pnpm download it when necessary.

```sh
pnpm install
pnpm check
```

The full check verifies formatting, type-checks the package, runs the tests,
smoke-tests extension loading without a model request, and audits dependencies.

To apply formatting:

```sh
pnpm format
```

The tests cover shortcut registration, fixed-width settled and pending border
rendering, transition notifications and cancellation, editor delegation, state
persistence, hidden context injection, reload restoration, and `edit`/`write`
blocking.

## License

Apache License 2.0. See [LICENSE](LICENSE).
