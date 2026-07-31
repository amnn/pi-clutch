import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import editClutchExtension, {
  BORDER_INDICATOR,
  DEFINITION,
  DEFINITION_CONTENT,
  DISENGAGED_REMINDER,
  decorateBorder,
} from "../index.ts";

const CLUTCH_SHORTCUT = "alt+e";

type EventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;
type Shortcut = (ctx: ExtensionContext) => void | Promise<void>;

interface TestEntry {
  type: "custom" | "custom_message";
  customType: string;
  id?: string;
  parentId?: string | null;
  data?: unknown;
  content?: string;
  display?: boolean;
}

interface SentMessage {
  message: {
    customType: string;
    content: string | unknown[];
    display: boolean;
    details?: unknown;
  };
  options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  };
}

interface TestTui {
  requestRender(): void;
}

type TestEditorFactory = (
  tui: TestTui,
  theme: unknown,
  keybindings: unknown,
) => TestEditorComponent;

class TestEditorComponent {
  text = "";
  readonly inputs: string[] = [];
  invalidations = 0;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  constructor(
    readonly renderLines: (width: number) => string[] = (width) => [
      "─".repeat(width),
      " ".repeat(width),
      "─".repeat(width),
    ],
  ) {}

  render(width: number): string[] {
    return this.renderLines(width);
  }

  invalidate(): void {
    this.invalidations += 1;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
  }

  handleInput(data: string): void {
    this.inputs.push(data);
  }
}

class ExtensionHarness {
  readonly handlers = new Map<string, EventHandler[]>();
  readonly shortcuts = new Map<
    string,
    { description?: string; handler: Shortcut }
  >();
  readonly notifications: Array<{
    message: string;
    type: "info" | "warning" | "error" | undefined;
  }> = [];
  readonly sentMessages: SentMessage[] = [];
  readonly appendedStates: unknown[] = [];
  readonly persistenceOrder: Array<"definition" | "state"> = [];
  branchEntries: TestEntry[];
  contextEntries: TestEntry[];
  idle = true;
  renderRequests = 0;
  editorFactory: TestEditorFactory | undefined;
  editor: TestEditorComponent | undefined;

  readonly baseEditor: TestEditorComponent;
  readonly tui: TestTui;
  readonly ctx: ExtensionContext;
  readonly api: ExtensionAPI;

  constructor(
    entries: TestEntry[] = [],
    contextEntries: TestEntry[] = entries,
    baseEditor = new TestEditorComponent(),
  ) {
    this.baseEditor = baseEditor;
    this.tui = {
      requestRender: () => {
        this.renderRequests += 1;
      },
    };
    this.editorFactory = () => this.baseEditor;
    this.branchEntries = entries.map((entry, index) => ({
      ...entry,
      id: `entry-${index}`,
      parentId: index === 0 ? null : `entry-${index - 1}`,
    }));
    this.contextEntries = [...contextEntries];

    this.ctx = {
      mode: "tui",
      ui: {
        getEditorComponent: () => this.editorFactory,
        setEditorComponent: (factory: TestEditorFactory | undefined) => {
          this.editorFactory = factory;
          this.editor = factory?.(this.tui, {}, {});
        },
        notify: (message: string, type?: "info" | "warning" | "error") => {
          this.notifications.push({ message, type });
        },
      },

      sessionManager: {
        getBranch: () => this.branchEntries,
        getLeafEntry: () => this.branchEntries.at(-1),
        getEntry: (id: string) =>
          this.branchEntries.find((entry) => entry.id === id),
        buildContextEntries: () => this.contextEntries,
      },
      isIdle: () => this.idle,
    } as unknown as ExtensionContext;

    this.api = {
      on: (event: string, handler: EventHandler) => {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
      },
      registerShortcut: (
        shortcut: string,
        options: { description?: string; handler: Shortcut },
      ) => {
        this.shortcuts.set(shortcut, options);
      },
      sendMessage: (
        message: SentMessage["message"],
        options?: SentMessage["options"],
      ) => {
        this.sentMessages.push(options ? { message, options } : { message });
        this.persistenceOrder.push("definition");
        const entry: TestEntry = {
          type: "custom_message",
          customType: message.customType,
          id: `entry-${this.branchEntries.length}`,
          parentId: this.branchEntries.at(-1)?.id ?? null,
          content: typeof message.content === "string" ? message.content : "",
          display: message.display,
        };
        this.branchEntries.push(entry);
        this.contextEntries.push(entry);
      },
      appendEntry: (customType: string, data?: unknown) => {
        this.appendedStates.push(data);
        this.persistenceOrder.push("state");
        const entry: TestEntry = {
          type: "custom",
          customType,
          id: `entry-${this.branchEntries.length}`,
          parentId: this.branchEntries.at(-1)?.id ?? null,
          data,
        };
        this.branchEntries.push(entry);
        this.contextEntries.push(entry);
      },
    } as unknown as ExtensionAPI;
  }

  async emit(event: string, payload: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of this.handlers.get(event) ?? []) {
      const next = await handler(payload, this.ctx);
      if (next !== undefined) result = next;
    }
    return result;
  }

  async start(reason: "startup" | "reload" = "startup"): Promise<void> {
    await this.emit("session_start", { type: "session_start", reason });
  }

  async toggle(): Promise<void> {
    const shortcut = this.shortcuts.get(CLUTCH_SHORTCUT);
    assert.ok(shortcut, `${CLUTCH_SHORTCUT} shortcut was not registered`);
    await shortcut.handler(this.ctx);
  }

  renderEditor(width = 12): string[] {
    assert.ok(this.editor, "editor decorator was not installed");
    return this.editor.render(width);
  }
}

function definitionEntry(): TestEntry {
  return {
    type: "custom_message",
    customType: DEFINITION.customType,
    content: DEFINITION.content,
    display: DEFINITION.display,
  };
}

function stateEntry(engaged: boolean): TestEntry {
  return {
    type: "custom",
    customType: "edit-clutch",
    data: { version: 1, engaged },
  };
}

function createHarness(
  entries: TestEntry[] = [],
  contextEntries: TestEntry[] = entries,
  editor?: TestEditorComponent,
): ExtensionHarness {
  const harness = new ExtensionHarness(entries, contextEntries, editor);
  editClutchExtension(harness.api);
  return harness;
}

function expectedDisengagedBorder(width: number): string {
  return "─".repeat(width - BORDER_INDICATOR.length) + BORDER_INDICATOR;
}

function topBorder(harness: ExtensionHarness, width = 12): string {
  const border = harness.renderEditor(width)[0];
  assert.ok(border, "editor did not render a top border");
  return border;
}

function toolCall(toolName: string): Record<string, unknown> {
  return {
    type: "tool_call",
    toolCallId: `call-${toolName}`,
    toolName,
    input: {},
  };
}

describe("edit clutch extension", () => {
  it("registers Alt+E and decorates only the disengaged editor border", async () => {
    const harness = createHarness();
    await harness.start();

    assert.equal(
      harness.shortcuts.get(CLUTCH_SHORTCUT)?.description,
      "Toggle the edit clutch",
    );
    assert.equal(topBorder(harness), "─".repeat(12));

    await harness.toggle();
    const disengagedBorder = topBorder(harness);
    assert.equal(disengagedBorder, expectedDisengagedBorder(12));
    assert.equal([...disengagedBorder].length, 12);
    assert.equal(harness.renderRequests, 1);
    assert.deepEqual(harness.notifications.at(-1), {
      message: "Clutch disengaged",
      type: "info",
    });

    await harness.toggle();
    assert.equal(topBorder(harness), "─".repeat(12));
    assert.equal(harness.renderRequests, 2);
    assert.deepEqual(harness.notifications.at(-1), {
      message: "Clutch engaged",
      type: "info",
    });
  });

  it("uses the last exact matching border sequence", () => {
    assert.equal(
      decorateBorder("─── ↑ 2 more ────────"),
      `─── ↑ 2 more ──${BORDER_INDICATOR}`,
    );
    assert.equal(
      decorateBorder("──────── label ──────── end ─────"),
      `──────── label ──${BORDER_INDICATOR} end ─────`,
      "an insufficient trailing run must not hide an earlier usable run",
    );
    assert.equal(
      decorateBorder("─── ↑ 2 more ─────"),
      "─── ↑ 2 more ─────",
      "the scroll indicator must remain untouched when no run fits",
    );
  });

  it("matches only the requested border styling", () => {
    const magenta = (text: string) => `\x1b[35m${text}\x1b[39m`;
    const cyan = (text: string) => `\x1b[36m${text}\x1b[39m`;
    const line = magenta("─").repeat(8);
    const decorated = decorateBorder(line, magenta);

    assert.equal(
      stripVTControlCharacters(decorated),
      `──${BORDER_INDICATOR}`,
    );
    assert.equal(
      decorated,
      magenta("─").repeat(2) + magenta(BORDER_INDICATOR),
    );

    const differentlyStyled = cyan("─").repeat(8);
    assert.equal(decorateBorder(differentlyStyled, magenta), differentlyStyled);
  });

  it("preserves editor identity, behavior, and non-border rows", async () => {
    const originalLines = [
      "─".repeat(12),
      "prompt      ",
      "─".repeat(12),
      "autocomplete",
    ];
    const baseEditor = new TestEditorComponent(() => originalLines);
    const harness = createHarness([], [], baseEditor);
    await harness.start();

    assert.equal(harness.editor, baseEditor);
    assert.equal(harness.renderEditor(), originalLines);
    harness.editor?.setText("hello");
    harness.editor?.handleInput("x");
    harness.editor?.invalidate();
    const onSubmit = () => {};
    if (harness.editor) harness.editor.onSubmit = onSubmit;

    assert.equal(baseEditor.getText(), "hello");
    assert.deepEqual(baseEditor.inputs, ["x"]);
    assert.equal(baseEditor.invalidations, 1);
    assert.equal(baseEditor.onSubmit, onSubmit);

    await harness.toggle();
    const decoratedLines = harness.renderEditor();
    assert.notEqual(decoratedLines, originalLines);
    assert.equal(decoratedLines[0], expectedDisengagedBorder(12));
    assert.deepEqual(decoratedLines.slice(1), originalLines.slice(1));
  });

  it("persists state and adds the hidden protocol definition only once", async () => {
    const harness = createHarness();
    await harness.start();

    await harness.toggle();
    assert.deepEqual(harness.appendedStates.at(-1), {
      version: 1,
      engaged: false,
    });
    assert.deepEqual(harness.persistenceOrder.slice(0, 2), [
      "definition",
      "state",
    ]);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.content, DEFINITION_CONTENT);
    assert.equal(harness.sentMessages[0]?.message.display, false);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: false });

    await harness.toggle();
    assert.deepEqual(harness.appendedStates.at(-1), {
      version: 1,
      engaged: true,
    });

    await harness.toggle();
    assert.equal(harness.sentMessages.length, 1);
  });

  it("appends one non-persistent reminder to the end of the outgoing context", async () => {
    const harness = createHarness();
    await harness.start();
    await harness.toggle();

    const trailingMessage: AgentMessage = {
      role: "custom",
      customType: "test-trailing-message",
      content: "A later assistant or tool-loop message",
      display: false,
      timestamp: 3,
    };
    const originalMessages: AgentMessage[] = [
      { role: "user", content: "Earlier request", timestamp: 1 },
      {
        role: "custom",
        customType: "test-between-message",
        content: "Existing context",
        display: false,
        timestamp: 2,
      },
      { role: "user", content: "Inspect this", timestamp: 3 },
      trailingMessage,
    ];
    const firstResult = (await harness.emit("context", {
      type: "context",
      messages: originalMessages,
    })) as { messages: AgentMessage[] };

    assert.equal(
      originalMessages.length,
      4,
      "the stored context must not be mutated",
    );
    assert.equal(firstResult.messages.length, 5);
    assert.equal(
      firstResult.messages[3],
      trailingMessage,
      "existing context must remain unchanged",
    );
    const reminder = firstResult.messages.at(-1);
    assert.equal(reminder?.role, "custom");
    if (reminder?.role !== "custom")
      assert.fail("expected a custom reminder message");
    assert.equal(reminder.content, DISENGAGED_REMINDER);
    assert.match(String(reminder.content), /^<clutch disengaged>/);
    assert.equal(reminder.display, false);

    const secondResult = (await harness.emit("context", {
      type: "context",
      messages: originalMessages,
    })) as { messages: AgentMessage[] };
    assert.equal(
      secondResult.messages.length,
      5,
      "ephemeral reminders must not accumulate",
    );
    assert.equal(
      harness.sentMessages.length,
      1,
      "only the persistent definition uses sendMessage",
    );

    await harness.toggle();
    assert.equal(
      await harness.emit("context", {
        type: "context",
        messages: originalMessages,
      }),
      undefined,
    );
  });

  it("defers the entire toggle until an active run settles", async () => {
    const harness = createHarness();
    await harness.start();
    harness.idle = false;

    await harness.toggle();
    assert.equal(
      harness.sentMessages.length,
      0,
      "a queued toggle must not steer an active run",
    );
    assert.equal(harness.appendedStates.length, 0);
    assert.deepEqual(harness.persistenceOrder, []);
    assert.equal(topBorder(harness), "─".repeat(12));
    assert.equal(
      harness.notifications.length,
      0,
      "notification waits for the state change",
    );
    assert.equal(
      await harness.emit("context", {
        type: "context",
        messages: [{ role: "user", content: "Keep working", timestamp: 1 }],
      }),
      undefined,
      "the clutch remains engaged until settlement",
    );

    harness.idle = true;
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0]?.message.content, DEFINITION_CONTENT);
    assert.deepEqual(harness.sentMessages[0]?.options, { triggerTurn: false });
    assert.deepEqual(harness.appendedStates.at(-1), {
      version: 1,
      engaged: false,
    });
    assert.deepEqual(harness.persistenceOrder, ["definition", "state"]);
    assert.equal(topBorder(harness), expectedDisengagedBorder(12));
    assert.deepEqual(harness.notifications.at(-1), {
      message: "Clutch disengaged",
      type: "info",
    });

    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(
      harness.sentMessages.length,
      1,
      "settled events must not repeat the toggle",
    );
  });

  it("cancels queued toggles in pairs", async () => {
    const harness = createHarness();
    await harness.start();
    harness.idle = false;

    await harness.toggle();
    await harness.toggle();

    harness.idle = true;
    await harness.emit("agent_settled", { type: "agent_settled" });
    assert.equal(harness.sentMessages.length, 0);
    assert.equal(harness.appendedStates.length, 0);
    assert.deepEqual(harness.persistenceOrder, []);
    assert.equal(topBorder(harness), "─".repeat(12));
    assert.equal(harness.notifications.length, 0);
  });

  it("blocks edit and write only while disengaged", async () => {
    const harness = createHarness();
    await harness.start();

    assert.equal(await harness.emit("tool_call", toolCall("edit")), undefined);
    await harness.toggle();

    for (const toolName of ["edit", "write"]) {
      const result = (await harness.emit("tool_call", toolCall(toolName))) as {
        block: boolean;
        reason: string;
      };
      assert.equal(result.block, true);
      assert.match(result.reason, new RegExp(`${toolName} is blocked`));
      assert.match(result.reason, /M-e/);
    }

    assert.equal(await harness.emit("tool_call", toolCall("read")), undefined);
    assert.equal(await harness.emit("tool_call", toolCall("bash")), undefined);

    await harness.toggle();
    assert.equal(await harness.emit("tool_call", toolCall("write")), undefined);
  });

  it("restores state without synthesizing a missing protocol definition", async () => {
    const harness = createHarness([stateEntry(false)]);
    await harness.start("reload");

    assert.equal(topBorder(harness), expectedDisengagedBorder(12));
    assert.equal(harness.sentMessages.length, 0);

    const contextResult = (await harness.emit("context", {
      type: "context",
      messages: [],
    })) as { messages: AgentMessage[] };
    assert.equal(contextResult.messages.at(-1)?.role, "custom");
  });

  it("restores the latest valid state on the active branch", async () => {
    const entries = [definitionEntry(), stateEntry(false), stateEntry(true)];
    const harness = createHarness(entries);
    await harness.start("reload");

    assert.equal(topBorder(harness), "─".repeat(12));
    assert.equal(harness.sentMessages.length, 0);
  });

  it("does not duplicate a definition already present on the active branch", async () => {
    const entries = [definitionEntry(), stateEntry(false)];
    const harness = createHarness(entries);
    await harness.start("reload");

    assert.equal(harness.sentMessages.length, 0);
    assert.equal(topBorder(harness), expectedDisengagedBorder(12));
  });
});
