import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, WorkspaceLeaf, addIcon } from "obsidian";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { ADAPTERS } from "./providers/registry";
import { resolveCli } from "./cli";
import { InlineEditModal } from "./ui/inline-edit";
import type { AgentEvent } from "./providers/types";

export default class ExoPlugin extends Plugin {
  settings!: MVASettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Exo brand mark — a concave 4-point star (matches the product logo).
    // addIcon wraps this in an svg with viewBox "0 0 100 100".
    addIcon(
      EXO_ICON,
      '<path fill="currentColor" d="M50 3 Q 50 50 97 50 Q 50 50 50 97 Q 50 50 3 50 Q 50 50 50 3 Z"/>'
    );

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon(EXO_ICON, "Open Exo", () => this.activateView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    const withView = (fn: (v: ChatView) => void) => () => {
      const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
      if (view instanceof ChatView) fn(view);
      else void this.activateView();
    };
    this.addCommand({ id: "new-tab", name: "New tab", callback: withView((v) => v.cmdNewTab()) });
    this.addCommand({
      id: "new-session",
      name: "New session (clear current tab)",
      callback: withView((v) => v.cmdNewSession()),
    });
    this.addCommand({ id: "close-tab", name: "Close current tab", callback: withView((v) => v.cmdCloseTab()) });
    this.addCommand({
      id: "fork-conversation",
      name: "Fork conversation into new tab",
      callback: withView((v) => v.cmdForkConversation()),
    });
    this.addCommand({
      id: "compact",
      name: "Compact conversation (free up context)",
      callback: withView((v) => v.cmdCompact()),
    });
    this.addCommand({
      id: "toggle-plan",
      name: "Toggle plan mode",
      callback: withView((v) => v.cmdTogglePlan()),
    });

    this.addCommand({
      id: "inline-edit",
      name: "Inline edit selection",
      editorCallback: (editor: Editor, ctx) => {
        if (!(ctx instanceof MarkdownView)) return;
        this.inlineEdit(editor);
      },
    });

    this.addSettingTab(new MVASettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  private vaultPath(): string {
    const a = this.app.vault.adapter;
    return a instanceof FileSystemAdapter ? a.getBasePath() : ".";
  }

  /** One-shot text transform: a transient (tool-less) session, returns the text. */
  private async oneShot(instruction: string, text: string, signal: AbortSignal): Promise<string> {
    const provider = this.settings.provider;
    const bin = provider === "claude" ? this.settings.claudeBin : this.settings.codexBin;
    const cli = await resolveCli(provider, bin);
    const session = ADAPTERS[provider].createSession({
      cli,
      model: provider === "claude" ? this.settings.claudeModel : this.settings.codexModel,
      effort: "default",
      cwd: this.vaultPath(),
      permissionMode: "default",
      toolsEnabled: false, // pure text transform — no tools needed
      fastStartup: true,
    });
    signal.addEventListener("abort", () => {
      try {
        session.dispose();
      } catch {
        /* already torn down */
      }
    });
    let out = "";
    const prompt =
      "You are an inline text editor inside Obsidian. Apply the instruction to the TEXT and return ONLY " +
      "the resulting text — no preamble, no explanation, no code fences, no quotes.\n\n" +
      `Instruction: ${instruction}\n\nTEXT:\n${text}`;
    try {
      await session.send(prompt, (e: AgentEvent) => {
        if (e.kind === "text-delta") out += e.text;
      });
    } finally {
      session.dispose();
    }
    return out.trim();
  }

  private inlineEdit(editor: Editor): void {
    const selection = editor.getSelection();
    const text = selection || editor.getLine(editor.getCursor().line);
    if (!text.trim()) {
      new Notice("Select some text (or place the cursor on a non-empty line) to edit.");
      return;
    }
    const hadSelection = selection.length > 0;
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const line = editor.getCursor().line;
    new InlineEditModal(this.app, text, (instr, t, sig) => this.oneShot(instr, t, sig), (next) => {
      if (hadSelection) {
        editor.replaceRange(next, from, to);
      } else {
        editor.replaceRange(next, { line, ch: 0 }, { line, ch: editor.getLine(line).length });
      }
    }).open();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private convoFile(): string {
    return `${this.manifest.dir}/conversations.json`;
  }

  /** Persisted conversation history (separate from settings/data.json). */
  async loadConversations(): Promise<unknown[]> {
    try {
      const p = this.convoFile();
      if (await this.app.vault.adapter.exists(p)) {
        const raw = await this.app.vault.adapter.read(p);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      /* corrupt/missing → start fresh */
    }
    return [];
  }

  /** Returns false (never throws) if the write failed, so callers can surface it. */
  async saveConversations(data: unknown[]): Promise<boolean> {
    try {
      await this.app.vault.adapter.write(this.convoFile(), JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  }
}
