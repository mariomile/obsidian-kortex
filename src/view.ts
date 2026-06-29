import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  FileSystemAdapter,
  FuzzySuggestModal,
  TFile,
  TFolder,
  setIcon,
  Notice,
} from "obsidian";
import { Autocomplete, type AcItem } from "./ui/autocomplete";
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

const MAX_CONVOS = 30;
const MAX_PERSIST_OUTPUT = 2000;

interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
}

/* ----- persisted data model ----- */
type Segment =
  | { t: "text"; md: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string };
type Message = { role: "user"; text: string } | { role: "assistant"; segments: Segment[] };

interface ConvoData {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  updatedAt?: number;
  messages: Message[];
}

interface Convo {
  id: string;
  listEl: HTMLElement;
  title: string;
  sessionId?: string;
  provider: ProviderId;
  model: string;
  allow: Set<string>;
  updatedAt?: number;
  messages: Message[];
}

interface AssistantCtx {
  el: HTMLElement;
  bodyEl: HTMLElement;
  cards: Map<string, ToolCard>;
  segById: Map<string, Segment>;
  segments: Segment[];
  curTextEl: HTMLElement | null;
  curTextSeg: { t: "text"; md: string } | null;
  curRaw: string;
  fullText: string;
  thinkingEl: HTMLElement | null;
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
  private composerEl!: HTMLElement;
  private galleryEl: HTMLElement | null = null;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private providerPill!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private contextEl!: HTMLElement;
  private excludeActiveNote = false;
  private manualAttached: string[] = [];
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
    await this.restore();
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
    histBtn.onclick = () => this.toggleGallery();

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

  /* ------------------------- persistence ---------------------------- */

  private async restore(): Promise<void> {
    const raw = (await this.plugin.loadConversations()) as ConvoData[];
    for (const d of raw) {
      if (!d || !Array.isArray(d.messages)) continue;
      const c: Convo = {
        id: d.id || `c${++convoSeed}`,
        listEl: createDiv({ cls: "mva-list" }),
        title: d.title || "New chat",
        sessionId: d.sessionId,
        provider: d.provider === "codex" ? "codex" : "claude",
        model: d.model || "",
        allow: new Set(),
        updatedAt: d.updatedAt,
        messages: d.messages,
      };
      this.renderConvoDom(c);
      this.convos.push(c);
    }
    convoSeed = Math.max(convoSeed, this.convos.length);
    if (this.convos.length === 0) {
      this.active = this.makeConvo();
      this.convos.push(this.active);
    } else {
      this.active = this.convos[this.convos.length - 1];
      this.sessionId = this.active.sessionId;
      this.provider = this.active.provider;
      this.model = this.active.model;
    }
    this.listWrap.empty();
    this.listWrap.appendChild(this.active.listEl);
    if (this.active.messages.length === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.scrollToBottom();
  }

  private serialize(): ConvoData[] {
    this.saveActive();
    const all = this.convos.includes(this.active) ? this.convos : [...this.convos, this.active];
    return all.slice(-MAX_CONVOS).map((c) => ({
      id: c.id,
      title: c.title,
      provider: c.provider,
      model: c.model,
      sessionId: c.sessionId,
      updatedAt: c.updatedAt,
      messages: c.messages.map((m) =>
        m.role === "assistant"
          ? {
              role: "assistant" as const,
              segments: m.segments.map((s) =>
                s.t === "tool"
                  ? { ...s, output: s.output.slice(0, MAX_PERSIST_OUTPUT) }
                  : s
              ),
            }
          : m
      ),
    }));
  }

  private persist(): void {
    void this.plugin.saveConversations(this.serialize());
  }

  /* ------------------------- conversations -------------------------- */

  private makeConvo(): Convo {
    return {
      id: `c${++convoSeed}`,
      listEl: createDiv({ cls: "mva-list" }),
      title: "New chat",
      provider: this.provider,
      model: this.model,
      allow: new Set(),
      messages: [],
    };
  }

  private saveActive(): void {
    if (!this.active) return;
    this.active.sessionId = this.sessionId;
    this.active.provider = this.provider;
    this.active.model = this.model;
    this.active.allow = this.sessionAllow;
  }

  private newConversation(): void {
    if (this.galleryEl) this.hideGallery();
    if (this.streaming) this.abort?.abort();
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    const c = this.makeConvo();
    this.convos.push(c);
    this.switchTo(c);
    this.persist();
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

  private toggleGallery(): void {
    if (this.galleryEl) this.hideGallery();
    else this.showGallery();
  }

  private hideGallery(): void {
    this.galleryEl?.remove();
    this.galleryEl = null;
    this.listEl.show();
    this.composerEl.show();
  }

  private showGallery(): void {
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.listEl.hide();
    this.composerEl.hide();
    const wrap = this.listWrap.createDiv({ cls: "mva-gallery-wrap" });
    this.galleryEl = wrap;
    wrap.createDiv({ cls: "mva-gallery-title", text: "Conversations" });
    const grid = wrap.createDiv({ cls: "mva-gallery" });

    const sorted = [...this.convos]
      .filter((c) => c.messages.length > 0 || c === this.active)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (sorted.length === 0) {
      grid.createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
      return;
    }
    for (const c of sorted) this.renderCard(grid, c);
  }

  private renderCard(grid: HTMLElement, c: Convo): void {
    const card = grid.createDiv({ cls: "mva-card" });
    if (c === this.active) card.addClass("is-active");
    const head = card.createDiv({ cls: "mva-card-head" });
    const dot = head.createSpan({ cls: "mva-dot" });
    dot.style.background = ADAPTERS[c.provider].brandColor;
    dot.style.color = ADAPTERS[c.provider].brandColor;
    head.createSpan({ cls: "mva-card-title", text: c.title || "New chat" });

    const preview = this.convoPreview(c);
    card.createDiv({ cls: "mva-card-preview", text: preview || "Empty conversation" });

    const meta = card.createDiv({ cls: "mva-card-meta" });
    meta.createSpan({ text: ADAPTERS[c.provider].displayName });
    const count = c.messages.filter((m) => m.role === "user").length;
    meta.createSpan({ text: `${count} message${count === 1 ? "" : "s"}` });
    if (c.updatedAt) meta.createSpan({ text: this.formatDate(c.updatedAt) });

    card.onclick = () => {
      this.hideGallery();
      this.switchTo(c);
    };
  }

  private convoPreview(c: Convo): string {
    let s = "";
    for (const m of c.messages) {
      const part =
        m.role === "user"
          ? m.text
          : m.segments
              .map((seg) => (seg.t === "text" ? seg.md : `↳ ${toolMeta(seg.name, seg.input).label}`))
              .join(" ");
      s += part.replace(/[#*`>_~]/g, "").replace(/\s+/g, " ").trim() + "  ";
      if (s.length > 320) break;
    }
    return s.trim();
  }

  private formatDate(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  }

  /* ---------------------------- context ----------------------------- */

  private buildComposer(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "mva-composer" });
    this.composerEl = bar;
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

    new Autocomplete(this.inputEl, row, [
      { trigger: "/", getItems: (q) => this.slashItems(q) },
      { trigger: "@", getItems: (q) => this.atItems(q) },
    ]);

    this.buildToolbar(bar);
  }

  /* --------------------------- autocomplete ------------------------- */

  private slashCache: { commands: string[]; skills: string[] } | null = null;

  private async loadSlash(): Promise<{ commands: string[]; skills: string[] }> {
    if (this.slashCache) return this.slashCache;
    const commands: string[] = [];
    const skills: string[] = [];
    const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;
    try {
      const c = await this.app.vault.adapter.list(".claude/commands");
      for (const f of c.files) if (f.endsWith(".md")) commands.push(base(f));
    } catch {
      /* no commands dir */
    }
    try {
      const s = await this.app.vault.adapter.list(".claude/skills");
      for (const folder of s.folders) skills.push(folder.split("/").pop() ?? folder);
      for (const f of s.files) if (f.endsWith(".md")) skills.push(base(f));
    } catch {
      /* no skills dir */
    }
    this.slashCache = { commands, skills };
    return this.slashCache;
  }

  private async slashItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    for (const p of this.plugin.settings.customPrompts) {
      if (p.name.toLowerCase().includes(q)) {
        out.push({ label: p.name, detail: "prompt", icon: "message-square", insert: p.prompt + " " });
      }
    }
    const { commands, skills } = await this.loadSlash();
    for (const c of commands) {
      if (c.toLowerCase().includes(q)) out.push({ label: c, detail: "command", icon: "terminal", insert: `/${c} ` });
    }
    for (const sk of skills) {
      if (sk.toLowerCase().includes(q)) out.push({ label: sk, detail: "skill", icon: "sparkles", insert: `/${sk} ` });
    }
    return out;
  }

  private atItems(query: string): AcItem[] {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (!f.path || f.path === "/") continue;
      if (q && !f.path.toLowerCase().includes(q)) continue;
      const isFolder = f instanceof TFolder;
      if (!isFolder && !(f instanceof TFile)) continue;
      const parent = f.parent && f.parent.path !== "/" ? f.parent.path : "";
      out.push({
        label: isFolder ? `${f.name}/` : f.name,
        detail: parent,
        icon: isFolder ? "folder" : "file-text",
        insert: `@${f.path}${isFolder ? "/" : ""} `,
        onSelect: () => {
          if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
          this.refreshContext();
        },
      });
      if (out.length >= 40) break;
    }
    return out;
  }

  private buildToolbar(bar: HTMLElement): void {
    const tb = bar.createDiv({ cls: "mva-toolbar" });
    const s = this.plugin.settings;

    const effort = this.toolbarSelect(tb, "Effort", [
      ["default", "Effort: default"],
      ["low", "Effort: low"],
      ["medium", "Effort: medium"],
      ["high", "Effort: high"],
      ["xhigh", "Effort: xhigh"],
      ["max", "Effort: max"],
    ]);
    effort.value = s.effort || "default";
    effort.onchange = () => {
      s.effort = effort.value;
      void this.plugin.saveSettings();
    };

    const perm = this.toolbarSelect(tb, "Permissions", [
      ["default", "Permissions: ask"],
      ["acceptEdits", "Permissions: accept edits"],
      ["plan", "Permissions: plan"],
      ["bypassPermissions", "Permissions: bypass"],
    ]);
    perm.value = s.permissionMode;
    perm.onchange = () => {
      s.permissionMode = perm.value as typeof s.permissionMode;
      void this.plugin.saveSettings();
    };
  }

  private toolbarSelect(parent: HTMLElement, label: string, opts: [string, string][]): HTMLSelectElement {
    const sel = parent.createEl("select", { cls: "mva-tb-select", attr: { "aria-label": label } });
    for (const [v, t] of opts) sel.createEl("option", { text: t }).value = v;
    return sel;
  }

  private activeNotePath(): string | null {
    const f = this.app.workspace.getActiveFile();
    return f ? f.path : null;
  }

  private contextPaths(): string[] {
    const out: string[] = [];
    const active = this.excludeActiveNote ? null : this.activeNotePath();
    if (active) out.push(active);
    for (const p of this.manualAttached) if (!out.includes(p)) out.push(p);
    return out;
  }

  private refreshContext(): void {
    if (!this.contextEl) return;
    this.contextEl.empty();
    const active = this.excludeActiveNote ? null : this.activeNotePath();
    if (active) this.addChip(active, true);
    for (const p of this.manualAttached) this.addChip(p, false);

    const add = this.contextEl.createDiv({ cls: "mva-chip mva-chip-add", attr: { "aria-label": "Attach a note" } });
    setIcon(add.createSpan({ cls: "mva-chip-icon" }), "plus");
    add.createSpan({ cls: "mva-chip-label", text: "Note" });
    add.onclick = () => this.pickNote();
  }

  private addChip(path: string, isActive: boolean): void {
    const chip = this.contextEl.createDiv({ cls: "mva-chip" });
    setIcon(chip.createSpan({ cls: "mva-chip-icon" }), "file-text");
    chip.createSpan({ cls: "mva-chip-label", text: path.split("/").pop() ?? path });
    const x = chip.createSpan({ cls: "mva-chip-x", attr: { "aria-label": "Remove" } });
    setIcon(x, "x");
    x.onclick = () => {
      if (isActive) this.excludeActiveNote = true;
      else this.manualAttached = this.manualAttached.filter((p) => p !== path);
      this.refreshContext();
    };
  }

  private pickNote(): void {
    new NotePicker(this.app, (f) => {
      if (!this.manualAttached.includes(f.path)) this.manualAttached.push(f.path);
      this.refreshContext();
    }).open();
  }

  private autoGrow(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }

  /* --------------------------- rendering ---------------------------- */

  private static readonly STARTERS: [string, string, string][] = [
    ["file-text", "Summarize this note", "Summarize the current note in 5 concise bullets."],
    ["network", "Find related notes", "Find notes in my vault related to the current note and explain how they connect."],
    ["list-checks", "Extract action items", "Extract every action item and open question from the current note as a checklist."],
    ["pen-line", "Draft from outline", "Expand the outline in the current note into full prose in my voice."],
  ];

  private renderEmptyState(): void {
    const empty = this.listEl.createDiv({ cls: "mva-empty" });
    const a = ADAPTERS[this.provider];
    empty.createDiv({ cls: "mva-empty-title", text: `What are we working on?` });
    empty.createDiv({
      cls: "mva-empty-sub",
      text: `${a.displayName} works inside your vault — read, write, and reason over your notes.`,
    });
    const starters = empty.createDiv({ cls: "mva-starters" });
    for (const [icon, label, prompt] of ChatView.STARTERS) {
      const chip = starters.createDiv({ cls: "mva-starter" });
      setIcon(chip.createSpan({ cls: "mva-starter-icon" }), icon);
      chip.createSpan({ text: label });
      chip.onclick = () => {
        this.inputEl.value = prompt;
        this.inputEl.focus();
        this.autoGrow();
      };
    }
  }

  private clearEmptyState(): void {
    this.listEl.querySelector(".mva-empty")?.remove();
  }

  /** Rebuild a conversation's DOM from its persisted messages. */
  private renderConvoDom(c: Convo): void {
    c.listEl.empty();
    for (const m of c.messages) {
      if (m.role === "user") {
        const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
        void MarkdownRenderer.render(this.app, m.text, el.createDiv({ cls: "mva-bubble" }), "", this);
      } else {
        const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
        const body = el.createDiv({ cls: "mva-assistant-body" });
        let full = "";
        for (const s of m.segments) {
          if (s.t === "text") {
            void MarkdownRenderer.render(this.app, s.md, body.createDiv({ cls: "mva-bubble" }), "", this);
            full += s.md;
          } else {
            const refs = this.createToolCard(body, s.name, s.input);
            this.finishToolCard(refs, s.ok !== false, s.output);
          }
        }
        if (full.trim()) this.attachActions(el, full);
      }
    }
  }

  private addUserTurn(text: string): void {
    this.clearEmptyState();
    if (this.active.title === "New chat") this.active.title = text.slice(0, 48);
    this.active.messages.push({ role: "user", text });
    const el = this.listEl.createDiv({ cls: "mva-turn mva-user" });
    void MarkdownRenderer.render(this.app, text, el.createDiv({ cls: "mva-bubble" }), "", this);
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
      segById: new Map(),
      segments: [],
      curTextEl: null,
      curTextSeg: null,
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
      ctx.curTextSeg = { t: "text", md: "" };
      ctx.segments.push(ctx.curTextSeg);
    }
    ctx.curRaw += text;
    ctx.curTextSeg!.md += text;
    ctx.fullText += text;
    this.scheduleRender(ctx);
  }

  private renderText(ctx: AssistantCtx, streaming = false): void {
    if (!ctx.curTextEl) return;
    const el = ctx.curTextEl;
    el.empty();
    void MarkdownRenderer.render(this.app, ctx.curRaw || "", el, "", this).then(() => {
      if (streaming && el.isConnected) el.createSpan({ cls: "mva-caret" });
    });
  }

  private scheduleRender(ctx: AssistantCtx): void {
    this.renderTarget = ctx;
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (this.renderTarget) this.renderText(this.renderTarget, true);
      this.scrollToBottom();
    }, 60);
  }

  private flushRender(ctx: AssistantCtx): void {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderText(ctx, false);
  }

  private attachActions(turnEl: HTMLElement, text: string): void {
    const bar = turnEl.createDiv({ cls: "mva-actions" });

    const copy = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Copy" } });
    setIcon(copy, "copy");
    copy.onclick = () => {
      void navigator.clipboard.writeText(text);
      this.flashIcon(copy, "check", "copy");
    };

    const insert = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Insert into note" } });
    setIcon(insert, "file-down");
    insert.onclick = () => void this.insertIntoNote(text, insert);
  }

  private flashIcon(btn: HTMLElement, on: string, off: string): void {
    btn.empty();
    setIcon(btn, on);
    window.setTimeout(() => {
      btn.empty();
      setIcon(btn, off);
    }, 1200);
  }

  private async insertIntoNote(text: string, btn: HTMLElement): Promise<void> {
    const f = this.app.workspace.getActiveFile();
    if (!f) {
      new Notice("Open a note first to insert into it.");
      return;
    }
    await this.app.vault.append(f, `\n\n${text}\n`);
    new Notice(`Inserted into ${f.basename}`);
    this.flashIcon(btn, "check", "file-down");
  }

  private openNote(path: string): void {
    let p = path;
    const base = this.vaultPath();
    if (base && p.startsWith(base)) p = p.slice(base.length).replace(/^\/+/, "");
    void this.app.workspace.openLinkText(p, "", false);
  }

  /* ------------------------------ tools ----------------------------- */

  private createToolCard(parent: HTMLElement, name: string, input: unknown): ToolCard {
    const meta = toolMeta(name, input);
    const card = parent.createDiv({ cls: "mva-tool is-running is-collapsed" });
    const head = card.createDiv({ cls: "mva-tool-head" });
    const statusEl = head.createDiv({ cls: "mva-tool-status" });
    setIcon(statusEl, "loader");
    setIcon(head.createDiv({ cls: "mva-tool-icon" }), meta.icon);
    head.createSpan({ cls: "mva-tool-name", text: meta.label });
    if (meta.target) {
      const t = head.createSpan({ cls: "mva-tool-target", text: meta.target });
      if (meta.openPath) {
        t.addClass("mva-link");
        t.onclick = (e) => {
          e.stopPropagation();
          this.openNote(meta.openPath as string);
        };
      }
    }
    const bodyEl = card.createDiv({ cls: "mva-tool-body" });
    renderToolDetail(bodyEl, name, input, null);
    head.onclick = () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed"));
    return { card, statusEl, bodyEl };
  }

  private finishToolCard(c: ToolCard, ok: boolean, output: string): void {
    c.card.removeClass("is-running");
    c.card.addClass(ok ? "is-ok" : "is-error");
    c.statusEl.empty();
    setIcon(c.statusEl, ok ? "check" : "x");
    if (output) {
      const out = c.bodyEl.createEl("pre", { cls: "mva-tool-output" });
      const text = output.length > 4000 ? output.slice(0, 4000) + "\n… (truncated)" : output;
      out.createEl("code", { text });
    }
  }

  private addToolCard(ctx: AssistantCtx, id: string, name: string, input: unknown): void {
    this.dropThinking(ctx);
    ctx.curTextEl = null;
    ctx.curTextSeg = null;
    const refs = this.createToolCard(ctx.bodyEl, name, input);
    ctx.cards.set(id, refs);
    const seg: Segment = { t: "tool", name, input, ok: null, output: "" };
    ctx.segments.push(seg);
    ctx.segById.set(id, seg);
    this.scrollToBottom();
  }

  private resolveToolCard(ctx: AssistantCtx, id: string, ok: boolean, output: string): void {
    const c = ctx.cards.get(id);
    const seg = ctx.segById.get(id);
    if (seg && seg.t === "tool") {
      seg.ok = ok;
      seg.output = output;
    }
    if (!c) return;
    this.finishToolCard(c, ok, output);
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
    ctx.curTextSeg = null;
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

    const paths = this.contextPaths();
    const message = paths.length
      ? `Context notes:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n${text}`
      : text;

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
          ctx.curTextSeg = null;
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
          effort: s.effort,
          systemPrompt: s.systemPrompt || undefined,
          message,
          sessionId: this.sessionId,
          cwd: this.vaultPath(),
          permissionMode: s.permissionMode,
          toolsEnabled: s.toolsEnabled,
          fastStartup: s.fastStartup,
          signal: this.abort.signal,
        },
        onEvent
      );
      this.flushRender(ctx);
      if (ctx.fullText.trim()) this.attachActions(ctx.el, ctx.fullText);
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
      if (ctx.segments.length) this.active.messages.push({ role: "assistant", segments: ctx.segments });
      this.active.updatedAt = Date.now();
      this.setStreaming(false);
      this.abort = undefined;
      this.persist();
      this.scrollToBottom();
    }
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }
}

/* ---------------------- note picker (multi-attach) ---------------------- */
class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: import("obsidian").App, private onPick: (f: TFile) => void) {
    super(app);
    this.setPlaceholder("Attach a note to the conversation…");
  }
  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.onPick(f);
  }
}
