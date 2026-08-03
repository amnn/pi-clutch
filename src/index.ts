import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const DEFINITION_CONTENT = `EDIT CLUTCH

This session uses an edit clutch controlled by the user.

The extension sets the clutch state for every request. By default the clutch is ENGAGED, unless the context ends with a message beginning with \`<clutch disengaged>\` along with instructions on what that means, closed by a \`</clutch>\` tag.

Do not look further back in the context -- these tags are only relevant at the end of the context.

Required behavior while disengaged:
- Explore, read, search, and analyze as needed.
- Explain findings, ask clarifying questions, compare options, and propose plans.
- Do not implement changes or modify project files.
- Do not proactively produce a patch.
- Calls to \`edit\` and \`write\` will be denied.

While engaged, operate normally and make changes when appropriate to the user's request.`;

export const DISENGAGED_REMINDER = `<clutch disengaged>Do not modify project files. Explore, read, search, and analyze.</clutch>`;

export const BORDER_INDICATOR_PENDING_DISENGAGE = /**/ "──┤⣿├──";
export const BORDER_INDICATOR_PENDING_ENGAGE = /*   */ "─┤⣿⣿⣿├─";
export const BORDER_INDICATOR_DISENGAGED = /*       */ "─┤   ├─";

const HORIZONTAL_BORDER = "─";

const KEY = "edit-clutch";
const MSG_DEFINITION = "edit-clutch-definition";
const MSG_DISENGAGED = "edit-clutch-disengaged";
const STATE_VERSION = 1;

/** Hidden message used to explain the clutch protocol to the model. */
export const DEFINITION = {
  customType: MSG_DEFINITION,
  content: DEFINITION_CONTENT,
  display: false,
  details: { version: STATE_VERSION },
} as const;

/** Ephemeral message added to the end of every message while the clutch is disengaged. */
export const REMINDER = {
  role: "custom",
  customType: MSG_DISENGAGED,
  content: DISENGAGED_REMINDER,
  display: false,
} as const;

interface PersistedState {
  version: typeof STATE_VERSION;
  engaged: boolean;
}

/**
 * Stamps the clutch into the last matching stretch of horizontal border.
 *
 * @param line Rendered editor-border line.
 * @param indicator Fixed-width clutch indicator to stamp into the border.
 * @param borderColor Optional colorizer used by the editor to render its border.
 * @returns The decorated line, or the original line when no exact border
 * sequence is long enough.
 *
 * @remarks Invariants:
 * - Only an exact sequence using the editor's current border style is replaced.
 * - The replacement has the same visible width as the matched sequence.
 */
export function decorateBorder(
  line: string,
  indicator: string,
  borderColor?: (text: string) => string,
): string {
  const horizontal = borderColor?.(HORIZONTAL_BORDER) ?? HORIZONTAL_BORDER;
  const target = horizontal.repeat(indicator.length);
  const index = line.lastIndexOf(target);
  if (index === -1) return line;

  const decorated = borderColor?.(indicator) ?? indicator;
  return line.slice(0, index) + decorated + line.slice(index + target.length);
}

/**
 * Iterates over the current session branch from its leaf toward its root.
 *
 * @param ctx Extension context whose session manager owns the active branch.
 * @returns A lazy iterator of branch entries in newest-to-oldest order.
 *
 * @remarks Invariants:
 * - The session manager's parent links form an acyclic chain ending at `null`.
 * - Only entries on the active branch are yielded.
 * - The full branch is never materialized in a temporary array.
 */
function* entries(ctx: ExtensionContext) {
  let entry = ctx.sessionManager.getLeafEntry();

  while (entry) {
    yield entry;

    entry = entry.parentId
      ? ctx.sessionManager.getEntry(entry.parentId)
      : undefined;
  }
}

/**
 * Checks whether the protocol definition has already been persisted on the
 * active branch.
 *
 * @param ctx - Extension context whose active branch should be inspected.
 * @returns `true` after finding the first matching hidden definition,
 * otherwise false.
 *
 * @remarks Invariant: `MSG_DEFINITION` uniquely identifies this extension's
 * protocol definition. Compaction visibility is intentionally irrelevant; this
 * check is about whether the branch has already recorded the definition.
 */
function hasDefinitionOnBranch(ctx: ExtensionContext): boolean {
  for (const entry of entries(ctx)) {
    if (entry.type === "custom_message" && entry.customType === MSG_DEFINITION)
      return true;
  }

  return false;
}

/**
 * The border indicator to render for the current clutch and pending states.
 *
 * @param engaged - Whether the clutch is currently engaged.
 * @param pending - Whether a clutch transition is currently pending.
 *
 * @returns The indicator to render, or `undefined` when the clutch is engaged
 * (not pending).
 */
function indicator(engaged: boolean, pending: boolean): string | undefined {
  if (pending) {
    return engaged
      ? BORDER_INDICATOR_PENDING_DISENGAGE
      : BORDER_INDICATOR_PENDING_ENGAGE;
  } else {
    return engaged ? undefined : BORDER_INDICATOR_DISENGAGED;
  }
}

/**
 * Restores the latest valid clutch state from the active branch.
 *
 * @param ctx Extension context whose branch should be searched.
 * @returns The newest valid `engaged` value, or `true` when none exists.
 *
 * @remarks
 * Invariants:
 * - Entries are examined newest first, so the first valid state is final.
 * - Unknown versions and malformed state entries are ignored.
 * - Engaged is the safe default for sessions that predate the extension.
 */
function restoreEngagedState(ctx: ExtensionContext): boolean {
  for (const e of entries(ctx)) {
    if (e.type !== "custom" || e.customType !== KEY) continue;
    if (typeof e.data !== "object" || e.data === null) continue;
    if (!("version" in e.data) || e.data.version !== STATE_VERSION) continue;
    if (!("engaged" in e.data) || typeof e.data.engaged !== "boolean") continue;

    return e.data.engaged;
  }

  return true;
}

export default function (pi: ExtensionAPI): void {
  let pending = false;
  let engaged = true;
  let defined = false;

  /**
   * Requests an editor redraw after a clutch-state change.
   *
   * Takes no parameters; it is set when the editor is decorated and cleared on
   * session shutdown.
   *
   * @returns Nothing.
   */
  let refreshEditor: (() => void) | undefined;

  /**
   * Persists the state-neutral protocol definition at most once per branch.
   *
   * Takes no parameters; it closes over `pi` and `defined`.
   *
   * Invariant: callers invoke this only while the agent is idle, so adding the
   * hidden message cannot steer an active run.
   */
  const ensureDefinition = () => {
    if (defined) return;
    pi.sendMessage(DEFINITION, { triggerTurn: false });
    defined = true;
  };

  /**
   * Installs a render-only decorator around the current editor factory.
   *
   * @param ctx Extension context that owns the editor-factory slot.
   * @returns Nothing.
   *
   * @remarks Invariants:
   * - Non-TUI contexts are left untouched.
   * - A previously installed editor factory remains responsible for editor
   * behavior; otherwise a standard `CustomEditor` is used.
   * - The factory observes the live settled and pending states on every render.
   * - Decorated render results are copied so an inner editor's cached lines are
   * never mutated.
   */
  const installEditorDecorator = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    const editor = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      refreshEditor = () => tui.requestRender();

      const inner = editor
        ? editor(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);
      const render = inner.render.bind(inner);

      inner.render = (width: number): string[] => {
        const lines = render(width);
        const decor = indicator(engaged, pending);
        if (decor === undefined) return lines;

        const top = lines[0];
        if (top === undefined) return lines;

        const decorated = decorateBorder(top, decor, inner.borderColor);
        if (decorated === top) return lines;

        const copy = lines.slice();
        copy[0] = decorated;
        return copy;
      };

      return inner;
    });
  };

  /**
   * Appends the current clutch state to the active branch.
   *
   * Takes no parameters; it snapshots the current value of `engaged`.
   *
   * Invariant: custom state entries never participate in model context.
   */
  const persistState = () => {
    pi.appendEntry<PersistedState>(KEY, {
      version: STATE_VERSION,
      engaged,
    });
  };

  /**
   * Restores runtime state from the active branch and refreshes the editor.
   *
   * @param ctx Extension context for the newly active session or branch.
   *
   * @remarks Invariants:
   * - The newest valid persisted state wins; malformed entries are ignored.
   * - Absence of persisted state means engaged.
   * - Restoration never synthesizes a missing protocol definition.
   * - Any toggle queued for the previous runtime or branch is discarded.
   */
  const restoreSessionState = (ctx: ExtensionContext) => {
    engaged = restoreEngagedState(ctx);
    defined = hasDefinitionOnBranch(ctx);
    pending = false;
    refreshEditor?.();
  };

  /**
   * Requests one clutch transition.
   *
   * @param ctx Extension context used to inspect idleness and update the UI.
   *
   * @remarks Invariants:
   * - While streaming, this flips `pending`, redraws its indicator, and notifies
   *   the user; settled state, context behavior, and persistence do not change.
   * - While idle, definition, state, border, and notification update together.
   * - Disengagement persists the definition before the state entry.
   */
  const toggle = (ctx: ExtensionContext) => {
    if (!ctx.isIdle()) {
      // Multiple shortcut presses before settlement cancel in pairs.
      pending = !pending;
      refreshEditor?.();

      const message = pending
        ? `Clutch ${engaged ? "disengagement" : "engagement"} pending`
        : "Clutch transition cancelled";

      ctx.ui.notify(message, "info");
      return;
    }

    pending = false;
    engaged = !engaged;
    if (!engaged) ensureDefinition();

    persistState();
    refreshEditor?.();
    ctx.ui.notify(`Clutch ${engaged ? "engaged" : "disengaged"}`, "info");
  };

  pi.registerShortcut("alt+e", {
    description: "Toggle the edit clutch",
    handler: toggle,
  });

  pi.on("session_start", (_event, ctx) => {
    restoreSessionState(ctx);
    installEditorDecorator(ctx);
  });

  pi.on("session_shutdown", () => {
    refreshEditor = undefined;
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreSessionState(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (pending && ctx.isIdle()) toggle(ctx);
  });

  pi.on("context", (event) => {
    if (engaged) return;

    return {
      // Appending leaves the entire assembled conversation as an unchanged
      // prefix, maximizing provider KV-cache reuse.
      messages: [...event.messages, { ...REMINDER, timestamp: Date.now() }],
    };
  });

  pi.on("tool_call", (event) => {
    if (engaged || (event.toolName !== "edit" && event.toolName !== "write"))
      return;

    return {
      block: true,
      reason: `Clutch disengaged: ${event.toolName} is blocked. Press M-e to engage.`,
    };
  });
}
