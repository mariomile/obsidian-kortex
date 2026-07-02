import { Editor, FileSystemAdapter, MarkdownView, Notice, Plugin, WorkspaceLeaf, addIcon } from "obsidian";
import { ChatView, VIEW_TYPE, EXO_ICON } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";
import { ADAPTERS } from "./providers/registry";
import { resolveCli } from "./cli";
import { InlineEditModal } from "./ui/inline-edit";
import type { AgentEvent } from "./providers/types";
import { computePlan, applyPlan, undoPlan, type DreamSnapshot } from "./obsidian/dream";
import { DreamModal } from "./ui/dream-modal";

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

    this.addCommand({
      id: "memory-dream-pass",
      name: "Run memory dream pass (consolidate _system/memory)",
      callback: () => {
        const plan = computePlan(this.app);
        new DreamModal(this.app, plan, async () => {
          const snap = await applyPlan(this.app, plan, new Date().toISOString());
          await this.saveDreamSnapshot(snap);
          new Notice(
            `Dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} marked stale. Undo from the command palette.`
          );
        }).open();
      },
    });
    this.addCommand({
      id: "memory-dream-undo",
      name: "Undo last memory dream pass",
      callback: async () => {
        const snap = await this.loadDreamSnapshot();
        if (!snap) {
          new Notice("No dream pass to undo.");
          return;
        }
        const n = await undoPlan(this.app, snap);
        await this.clearDreamSnapshot();
        new Notice(`Undid the dream pass — restored ${n} file(s).`);
      },
    });
    // Hourly check; runs a scheduled pass only when due per settings.
    this.registerInterval(window.setInterval(() => void this.maybeScheduledDreamPass(), 60 * 60 * 1000));

    this.addSettingTab(new MVASettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
      if (leaf.view instanceof ChatView) leaf.view.focusComposer();
    }
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
    // Seed a few example reusable prompts on first run (once) so "Your prompts"
    // isn't empty. They're editable/deletable in Settings; never re-seeded.
    if (!this.settings.seededPrompts && this.settings.customPrompts.length === 0) {
      this.settings.customPrompts = [
        { name: "Distill", prompt: "Distill this note to its 3 core ideas, each as one crisp sentence." },
        { name: "Devil's advocate", prompt: "Argue the strongest case against the main claim in this note." },
        { name: "Next actions", prompt: "Turn this note into a short checklist of concrete next actions." },
      ];
      this.settings.seededPrompts = true;
      await this.saveSettings();
    }
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

  private dreamFile(): string {
    return `${this.manifest.dir}/dream-snapshot.json`;
  }
  async saveDreamSnapshot(s: DreamSnapshot): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.dreamFile(), JSON.stringify(s));
    } catch {
      /* non-fatal */
    }
  }
  async loadDreamSnapshot(): Promise<DreamSnapshot | null> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) return JSON.parse(await this.app.vault.adapter.read(p)) as DreamSnapshot;
    } catch {
      /* corrupt/missing */
    }
    return null;
  }
  async clearDreamSnapshot(): Promise<void> {
    try {
      const p = this.dreamFile();
      if (await this.app.vault.adapter.exists(p)) await this.app.vault.adapter.remove(p);
    } catch {
      /* ignore */
    }
  }
  private async maybeScheduledDreamPass(): Promise<void> {
    const sched = this.settings.dreamPassSchedule;
    if (sched === "off") return;
    const now = Date.now();
    const period = sched === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    if (this.settings.lastDreamPass && now - this.settings.lastDreamPass < period) return;
    const plan = computePlan(this.app);
    this.settings.lastDreamPass = now;
    await this.saveSettings();
    if (plan.promote.length + plan.dedup.length + plan.stale.length === 0) return;
    const snap = await applyPlan(this.app, plan, new Date().toISOString());
    await this.saveDreamSnapshot(snap);
    new Notice(
      `Scheduled dream pass: ${plan.promote.length} promoted, ${plan.dedup.length} merged, ${plan.stale.length} stale. Undo from the command palette.`
    );
  }
}
