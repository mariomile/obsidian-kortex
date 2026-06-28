import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  FileSystemAdapter,
  Menu,
  setIcon,
  Notice,
} from "obsidian";
import type MarioverseAgentPlugin from "./main";
import { resolveCli, describeError, isAbort } from "./cli";
import { claudeAdapter } from "./providers/claude";
import { codexAdapter } from "./providers/codex";
import type { AgentEvent, ProviderAdapter, ProviderId } from "./providers/types";
import { toolMeta, renderToolDetail, READ_ONLY_TOOLS } from "./ui/tools";

export const VIEW_TYPE = "marioverse-agent-view";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
}

/** A single assistant response: an ordered flow of text segments + tool cards. */
interface AssistantCtx {
  el: HTMLElement;
  bodyEl: HTMLElement;
  cards: Map<string, ToolCard>;
  curTextEl: HTMLElement | null;
  curRaw: string;
  fullText: string;
  thinkingEl: HTMLElement | null;
}

/** A conversation kept alive via its (detached) rendered DOM. */
interface Convo {
  id: string;
  listEl: HTMLElement;
  title: string;
  sessionId?: string;
  provider: ProviderId;
  model: string;
  allow: Set<string>;
}

let convoSeed = 0;

export class ChatView extends ItemView {
  private provider: ProviderId;
  private model: string;
  private sessionId?: string;
  private streaming = false;
  private abort?: AbortController;
  private sessionAllow = new Set<string>();

  private convos: Convo[] = [];
  private active!: Convo;

  private listWrap!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private providerPill!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private contextEl!: HTMLElement;
  private excludeActiveNote = false;
  private renderTimer: number | null = null;
  private renderTarget: AssistantCtx | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: MarioverseAgentPlugin) {
    super(leaf);
    this.provider = plugin.settings.provider;
    this.model = this.provider === "claude" ? plugin.settings.claudeModel : plugin.settings.codexModel;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Marioverse Agent";
  }
  getIcon(): string {
    return "bot";
  }

  private get listEl(): HTMLElement {
    return this.active.listEl;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    this.buildHeader(root);
    this.listWrap = root.createDiv({ cls: "mva-list-wrap" });
    this.buildComposer(root);
    this.active = this.makeConvo();
    this.listWrap.appendChild(this.active.listEl);
    this.renderEmptyState();
    this.refreshContext();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshContext()));
  }

  async onClose(): Promise<void> {
    try {
      this.abort?.abort();
    } catch {
      /* ignore abort of an already-settled controller */
    }
  }

  /* ----------------------------- header ----------------------------- */

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mva-header" });
    this.providerPill = header.createDiv({ cls: "mva-pill", attr: { "aria-label": "Switch provider" } });
    this.providerPill.onclick = () => this.cycleProvider();
    this.modelSelect = header.createEl("select", { cls: "mva-model" });
    this.modelSelect.onchange = () => {
      this.model = this.modelSelect.value;
      this.persistModel();
    };
    header.createDiv({ cls: "mva-spacer" }).style.flex = "1";

    const histBtn = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "History" } });
    setIcon(histBtn, "history");
    histBtn.onclick = (e) => this.openHistory(e);

    const newChat = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.onclick = () => this.newConversation();

    this.refreshProviderUI();
  }

  private cycleProvider(): void {
    if (this.streaming) return;
    this.provider = this.provider === "claude" ? "codex" : "claude";
    this.model = this.provider === "claude" ? this.plugin.settings.claudeModel : this.plugin.settings.codexModel;
    this.sessionId = undefined;
    this.sessionAllow.clear();
    this.refreshProviderUI();
  }

  private refreshProviderUI(): void {
    const a = ADAPTERS[this.provider];
    this.providerPill.empty();
    const dot = this.providerPill.createSpan({ cls: "mva-dot" });
    dot.style.background = a.brandColor;
    dot.style.color = a.brandColor;
    this.providerPill.createSpan({ text: a.displayName });
    this.providerPill.style.setProperty("--mva-brand", a.brandColor);
    this.modelSelect.empty();
    for (const m of a.models()) {
      this.modelSelect.createEl("option", { text: m.label }).value = m.id;
    }
    this.modelSelect.value = this.model || "";
  }

  private persistModel(): void {
    if (this.provider === "claude") this.plugin.settings.claudeModel = this.model;
    else this.plugin.settings.codexModel = this.model;
    void this.plugin.saveSettings();
  }

  /* ------------------------- conversations -------------------------- */

  private makeConvo(): Convo {
    const listEl = createDiv({ cls: "mva-list" });
    return {
      id: `c${++convoSeed}`,
      listEl,
      title: "New chat",
      provider: this.provider,
      model: this.model,
      allow: new Set(),
    };
  }

  private saveActive(): void {
    this.active.sessionId = this.sessionId;
    this.active.provider = this.provider;
    this.active.model = this.model;
    this.active.allow = this.sessionAllow;
  }

  private newConversation(): void {
    if (this.streaming) this.abort?.abort();
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    const c = this.makeConvo();
    this.convos.push(c);
    this.switchTo(c);
  }

  private switchTo(c: Convo): void {
    if (c === this.active) return;
    if (this.streaming) this.abort?.abort();
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.active = c;
    this.sessionId = c.sessionId;
    this.provider = c.provider;
    this.model = c.model;
    this.sessionAllow = c.allow;
    this.listWrap.empty();
    this.listWrap.appendChild(c.listEl);
    if (c.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.scrollToBottom();
  }

  private openHistory(e: MouseEvent): void {
    const menu = new Menu();
    const all = this.convos.includes(this.active) ? this.convos : [...this.convos, this.active];
    if (all.length === 0) {
      menu.addItem((i) => i.setTitle("No conversations yet").setDisabled(true));
    }
    for (const c of [...all].reverse()) {
      menu.addItem((i) =>
        i
          .setTitle(c.title || "New chat")
          .setChecked(c === this.active)
          .onClick(() => this.switchTo(c))
      );
    }
    menu.showAtMouseEvent(e);
  }

  /* ---------------------------- context ----------------------------- */

  private buildComposer(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "mva-composer" });
    this.contextEl = bar.createDiv({ cls: "mva-context" });
    const row = bar.createDiv({ cls: "mva-input-row" });
    this.inputEl = row.createEl("textarea", {
      cls: "mva-input",
      attr: { rows: "1", placeholder: "Message the agent…  (⏎ to send, ⇧⏎ for newline)" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.streaming) void this.send();
      }
    });
    this.sendBtn = row.createEl("button", { cls: "mva-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.onclick = () => (this.streaming ? this.stop() : void this.send());
  }

  private activeNotePath(): string | null {
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : null;
  }

  private refreshContext(): void {
    if (!this.contextEl) return;
    this.contextEl.empty();
    const path = this.activeNotePath();
    if (!path || this.excludeActiveNote) {
      this.contextEl.toggleClass("is-empty", true);
      return;
    }
    this.contextEl.toggleClass("is-empty", false);
    const chip = this.contextEl.createDiv({ cls: "mva-chip" });
    setIcon(chip.createSpan({ cls: "mva-chip-icon" }), "file-text");
    chip.createSpan({ cls: "mva-chip-label", text: path.split("/").pop() ?? path });
    const x = chip.createSpan({ cls: "mva-chip-x", attr: { "aria-label": "Remove" } });
    setIcon(x, "x");
    x.onclick = () => {
      this.excludeActiveNote = true;
      this.refreshContext();
    };
  }

  private autoGrow(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  /* --------------------------- rendering ---------------------------- */

  private renderEmptyState(): void {
    const empty = this.listEl.createDiv({ cls: "mva-empty" });
    const a = ADAPTERS[this.provider];
    setIcon(empty.createDiv({ cls: "mva-empty-icon" }), "sparkles");
    empty.createDiv({ cls: "mva-empty-title", text: `Ask ${a.displayName} anything` });
    empty.createDiv({
      cls: "mva-empty-sub",
      text: this.plugin.settings.toolsEnabled
        ? "Agentic mode is on — your vault is the working directory."
        : "Your vault is the working directory. Start a conversation below.",
    });
  }

  private clearEmptyState(): void {
    this.listEl.querySelector(".mva-empty")?.remove();
  }

  private addUserTurn(text: string): void {
    this.clearEmptyState();
    if (this.active.title === "New chat") this.active.title = text.slice(0, 48);
    const el = this.listEl.createDiv({ cls: "mva-turn mva-user" });
    const bubble = el.createDiv({ cls: "mva-bubble" });
    void MarkdownRenderer.render(this.app, text, bubble, "", this);
    this.scrollToBottom();
  }

  private addAssistantTurn(): AssistantCtx {
    this.clearEmptyState();
    const el = this.listEl.createDiv({ cls: "mva-turn mva-assistant" });
    const bodyEl = el.createDiv({ cls: "mva-assistant-body" });
    const thinking = bodyEl.createDiv({ cls: "mva-thinking" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    thinking.createSpan({ cls: "mva-thinking-dot" });
    const ctx: AssistantCtx = {
      el,
      bodyEl,
      cards: new Map(),
      curTextEl: null,
      curRaw: "",
      fullText: "",
      thinkingEl: thinking,
    };
    this.scrollToBottom();
    return ctx;
  }

  private dropThinking(ctx: AssistantCtx): void {
    ctx.thinkingEl?.remove();
    ctx.thinkingEl = null;
  }

  private appendText(ctx: AssistantCtx, text: string): void {
    this.dropThinking(ctx);
    if (!ctx.curTextEl) {
      ctx.curTextEl = ctx.bodyEl.createDiv({ cls: "mva-bubble" });
      ctx.curRaw = "";
    }
    ctx.curRaw += text;
    ctx.fullText += text;
    this.scheduleRender(ctx);
  }

  private renderText(ctx: AssistantCtx): void {
    if (!ctx.curTextEl) return;
    ctx.curTextEl.empty();
    void MarkdownRenderer.render(this.app, ctx.curRaw || "", ctx.curTextEl, "", this);
  }

  private scheduleRender(ctx: AssistantCtx): void {
    this.renderTarget = ctx;
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.renderTarget) this.renderText(this.renderTarget);
      this.scrollToBottom();
    }, 60);
  }

  private flushRender(ctx: AssistantCtx): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderText(ctx);
  }

  private addCopyButton(ctx: AssistantCtx): void {
    if (!ctx.fullText.trim()) return;
    const btn = ctx.el.createEl("button", { cls: "mva-copy", attr: { "aria-label": "Copy" } });
    setIcon(btn, "copy");
    btn.onclick = () => {
      void navigator.clipboard.writeText(ctx.fullText);
      btn.empty();
      setIcon(btn, "check");
      window.setTimeout(() => {
        btn.empty();
        setIcon(btn, "copy");
      }, 1200);
    };
  }

  /* ------------------------------ tools ----------------------------- */

  private addToolCard(ctx: AssistantCtx, id: string, name: string, input: unknown): void {
    this.dropThinking(ctx);
    ctx.curTextEl = null;
    const meta = toolMeta(name, input);
    const card = ctx.bodyEl.createDiv({ cls: "mva-tool is-running is-collapsed" });
    const head = card.createDiv({ cls: "mva-tool-head" });
    const statusEl = head.createDiv({ cls: "mva-tool-status" });
    setIcon(statusEl, "loader");
    setIcon(head.createDiv({ cls: "mva-tool-icon" }), meta.icon);
    head.createSpan({ cls: "mva-tool-name", text: meta.label });
    if (meta.target) head.createSpan({ cls: "mva-tool-target", text: meta.target });
    const bodyEl = card.createDiv({ cls: "mva-tool-body" });
    renderToolDetail(bodyEl, name, input, null);
    head.onclick = () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed"));
    ctx.cards.set(id, { card, statusEl, bodyEl });
    this.scrollToBottom();
  }

  private resolveToolCard(ctx: AssistantCtx, id: string, ok: boolean, output: string): void {
    const c = ctx.cards.get(id);
    if (!c) return;
    c.card.removeClass("is-running");
    c.card.addClass(ok ? "is-ok" : "is-error");
    c.statusEl.empty();
    setIcon(c.statusEl, ok ? "check" : "x");
    if (output) {
      const out = c.bodyEl.createEl("pre", { cls: "mva-tool-output" });
      const text = output.length > 4000 ? output.slice(0, 4000) + "\n… (truncated)" : output;
      out.createEl("code", { text });
    }
    this.scrollToBottom();
  }

  /* -------------------------- permissions --------------------------- */

  private addPermissionCard(
    ctx: AssistantCtx,
    tool: string,
    input: unknown,
    resolve: (d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }) => void
  ): void {
    this.dropThinking(ctx);
    ctx.curTextEl = null;
    const meta = toolMeta(tool, input);
    const card = ctx.bodyEl.createDiv({ cls: "mva-perm" });
    const head = card.createDiv({ cls: "mva-perm-head" });
    setIcon(head.createDiv({ cls: "mva-perm-icon" }), "shield-alert");
    head.createSpan({ cls: "mva-perm-title", text: `Allow ${meta.label}?` });
    if (meta.target) head.createSpan({ cls: "mva-tool-target", text: meta.target });
    renderToolDetail(card.createDiv({ cls: "mva-perm-detail" }), tool, input, null);

    const actions = card.createDiv({ cls: "mva-perm-actions" });
    const settle = (
      d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }
    ) => {
      card.addClass("is-resolved");
      actions.empty();
      card.createDiv({
        cls: "mva-perm-verdict",
        text: d.behavior === "deny" ? "Denied" : d.remember ? "Always allowed" : "Allowed",
      });
      resolve(d);
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Allow once" }).onclick = () =>
      settle({ behavior: "allow" });
    actions.createEl("button", { cls: "mva-btn", text: "Always allow" }).onclick = () => {
      this.sessionAllow.add(tool);
      settle({ behavior: "allow", remember: true });
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Deny" }).onclick = () =>
      settle({ behavior: "deny", message: "Denied by user." });
    this.scrollToBottom();
  }

  /* ----------------------------- send ------------------------------- */

  private scrollToBottom(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private setStreaming(on: boolean): void {
    this.streaming = on;
    this.sendBtn.empty();
    setIcon(this.sendBtn, on ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-streaming", on);
  }

  private stop(): void {
    this.abort?.abort();
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.streaming) return;
    this.inputEl.value = "";
    this.autoGrow();

    // Build the message, optionally prefixed with the active-note context.
    const notePath = this.excludeActiveNote ? null : this.activeNotePath();
    const message = notePath ? `Current note: ${notePath}\n\n${text}` : text;

    this.addUserTurn(text);
    const ctx = this.addAssistantTurn();

    this.abort = new AbortController();
    this.setStreaming(true);

    const adapter = ADAPTERS[this.provider];
    const s = this.plugin.settings;
    const bin = this.provider === "claude" ? s.claudeBin : s.codexBin;

    const onEvent = (e: AgentEvent) => {
      switch (e.kind) {
        case "text-delta":
          this.appendText(ctx, e.text);
          break;
        case "tool-call-start":
          this.addToolCard(ctx, e.id, e.name, e.input);
          break;
        case "tool-call-result":
          this.resolveToolCard(ctx, e.id, e.ok, e.output);
          break;
        case "permission-request":
          if ((s.autoAllowRead && READ_ONLY_TOOLS.has(e.tool)) || this.sessionAllow.has(e.tool)) {
            e.resolve({ behavior: "allow" });
          } else {
            this.addPermissionCard(ctx, e.tool, e.input, e.resolve);
          }
          break;
        case "turn-end":
          if (e.sessionId) this.sessionId = e.sessionId;
          break;
        case "error":
          this.dropThinking(ctx);
          ctx.curTextEl = null;
          ctx.bodyEl.createDiv({ cls: "mva-inline-error", text: `⚠️ ${e.message}` });
          break;
      }
    };

    try {
      const cli = await resolveCli(this.provider, bin);
      await adapter.send(
        {
          cli,
          model: this.model,
          systemPrompt: s.systemPrompt || undefined,
          message,
          sessionId: this.sessionId,
          cwd: this.vaultPath(),
          permissionMode: s.permissionMode,
          toolsEnabled: s.toolsEnabled,
          signal: this.abort.signal,
        },
        onEvent
      );
      this.flushRender(ctx);
      this.addCopyButton(ctx);
    } catch (err) {
      this.flushRender(ctx);
      if (isAbort(err)) {
        this.dropThinking(ctx);
        ctx.el.addClass("mva-aborted");
        if (!ctx.fullText && ctx.cards.size === 0) {
          ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
        }
      } else {
        this.dropThinking(ctx);
        const msg = describeError(err, adapter.displayName);
        if (!ctx.bodyEl.querySelector(".mva-inline-error")) {
          ctx.bodyEl.createDiv({ cls: "mva-inline-error", text: `⚠️ ${msg}` });
        }
        new Notice(msg);
      }
    } finally {
      this.setStreaming(false);
      this.abort = undefined;
      this.scrollToBottom();
    }
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }
}
