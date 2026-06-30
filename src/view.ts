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
import type KortexPlugin from "./main";
import { resolveCli, describeError, isAbort } from "./cli";
import { claudeAdapter } from "./providers/claude";
import { codexAdapter } from "./providers/codex";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ProviderAdapter,
  ProviderId,
} from "./providers/types";
import { toolMeta, toolFilePath, renderToolDetail, READ_ONLY_TOOLS } from "./ui/tools";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS, OBSIDIAN_MEMORY_TOOLS } from "./obsidian/tools";
import { readBootContext } from "./obsidian/memory";
import { relatedNotes, basename as noteBasename } from "./obsidian/graph";
import { renderNeighborhoodPanel, renderMiniGraph, wikilinkify, type TouchedNote } from "./ui/graph-view";
import { renderCapabilitiesPanel } from "./ui/capabilities";

export const VIEW_TYPE = "kortex-view";

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
  // Per-conversation runtime (enables parallel conversations).
  session: AgentSession | null;
  sessionSig: string;
  streaming: boolean;
  stopped: boolean; // set by stop() so the turn renders as "Stopped", not an error
  pendingPerm: (() => void) | null; // cancels an open permission card on stop
  queue: string[];
  pendingEl: HTMLElement | null; // container for queued-message chips
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
  userText: string;
  thinkingEl: HTMLElement | null;
  reasonEl: HTMLElement | null;
  reasonBody: HTMLElement | null;
  reasonRaw: string;
  sources: Set<string>;
  touched: TouchedNote[];
  convo: Convo;
  /** Per-turn debounce timer, so parallel conversations don't fight over a shared one. */
  renderTimer: number | null;
}

/** Abort a turn if no event arrives for this long (avoids infinite loading). */
const IDLE_TIMEOUT = 120_000;

let convoSeed = 0;

export class ChatView extends ItemView {
  private provider: ProviderId;
  private model: string;
  private usageEl: HTMLElement | null = null;

  /** Active conversation is streaming (drives the send/stop button). */
  private get streaming(): boolean {
    return this.active?.streaming ?? false;
  }
  private obsidianServer: unknown = null;
  private memoryPreamble = "";
  private neighborhoodEl: HTMLElement | null = null;

  private convos: Convo[] = [];
  private active!: Convo;

  private listWrap!: HTMLElement;
  private composerEl!: HTMLElement;
  private galleryEl: HTMLElement | null = null;
  private capsEl: HTMLElement | null = null;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private brandDot!: HTMLElement;
  private providerSelect!: HTMLSelectElement;
  private modelSelect!: HTMLSelectElement;
  private contextEl!: HTMLElement;
  private excludeActiveNote = false;
  private manualAttached: string[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: KortexPlugin) {
    super(leaf);
    this.provider = plugin.settings.provider;
    this.model = this.provider === "claude" ? plugin.settings.claudeModel : plugin.settings.codexModel;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Kortex";
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
    this.neighborhoodEl = root.createDiv({ cls: "mva-nb is-hidden" });
    this.listWrap = root.createDiv({ cls: "mva-list-wrap" });
    this.buildComposer(root);
    await this.restore();
    this.refreshContext();
    this.refreshNeighborhood();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshContext();
        this.refreshNeighborhood();
        this.refreshSurfacing();
      })
    );
  }

  async onClose(): Promise<void> {
    // this.active is always within this.convos, so the loop covers it.
    for (const c of this.convos) this.dropSession(c);
  }

  /* --------------------------- session mgmt ------------------------- */

  private sessionSigOf(c: Convo): string {
    const s = this.plugin.settings;
    return [
      c.provider,
      c.model,
      s.effort,
      s.toolsEnabled,
      s.permissionMode,
      s.fastStartup,
      s.systemPrompt,
      s.obsidianToolsEnabled,
      s.nativeFirst,
      s.memoryReadEnabled,
      c.id,
    ].join("|");
  }

  private async ensureSession(c: Convo): Promise<AgentSession> {
    const sig = this.sessionSigOf(c);
    if (c.session && sig === c.sessionSig) return c.session;
    c.session?.dispose();
    const s = this.plugin.settings;
    const bin = c.provider === "claude" ? s.claudeBin : s.codexBin;
    const cli = await resolveCli(c.provider, bin);

    // Obsidian-native tools are Claude-only and require agentic (gated) mode.
    const useObsidian = s.obsidianToolsEnabled && s.toolsEnabled && c.provider === "claude";
    if (useObsidian && !this.obsidianServer) this.obsidianServer = createObsidianToolServer(this.app);

    let memoryPreamble: string | undefined;
    if (s.memoryReadEnabled && c.provider === "claude") {
      if (!this.memoryPreamble) this.memoryPreamble = await readBootContext(this.app);
      memoryPreamble = this.memoryPreamble || undefined;
    }

    c.session = ADAPTERS[c.provider].createSession({
      cli,
      model: c.model,
      effort: s.effort,
      systemPrompt: s.systemPrompt || undefined,
      cwd: this.vaultPath(),
      permissionMode: s.permissionMode,
      toolsEnabled: s.toolsEnabled,
      fastStartup: s.fastStartup,
      resumeSessionId: c.sessionId,
      obsidianServer: useObsidian ? this.obsidianServer : undefined,
      nativeFirst: useObsidian && s.nativeFirst,
      memoryPreamble,
    });
    c.sessionSig = sig;
    return c.session;
  }

  private dropSession(c: Convo): void {
    c.session?.dispose();
    c.session = null;
    c.sessionSig = "";
  }

  /* ----------------------------- header ----------------------------- */

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mva-header" });
    this.brandDot = header.createSpan({ cls: "mva-dot" });
    header.createSpan({ cls: "mva-brand-name", text: "Kortex" });
    header.createDiv({ cls: "mva-spacer" }).style.flex = "1";

    const histBtn = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "History" } });
    setIcon(histBtn, "history");
    histBtn.onclick = () => this.toggleGallery();

    const newChat = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.onclick = () => this.newConversation();
  }

  private onProviderChange(next: ProviderId): void {
    if (this.streaming || next === this.provider) {
      this.providerSelect.value = this.provider; // revert if blocked
      return;
    }
    this.provider = next;
    this.model = next === "claude" ? this.plugin.settings.claudeModel : this.plugin.settings.codexModel;
    this.active.provider = next;
    this.active.model = this.model;
    this.active.sessionId = undefined;
    this.active.allow.clear();
    this.dropSession(this.active);
    this.updateUsage(null);
    this.refreshProviderUI();
  }

  private refreshProviderUI(): void {
    const a = ADAPTERS[this.provider];
    this.providerSelect.value = this.provider;
    this.brandDot.style.background = a.brandColor;
    this.brandDot.style.color = a.brandColor;
    this.contentEl.style.setProperty("--mva-brand", a.brandColor);
    this.modelSelect.empty();
    for (const m of a.models()) {
      this.modelSelect.createEl("option", { text: m.label }).value = m.id;
    }
    this.modelSelect.value = this.model || "";
  }

  private persistModel(): void {
    if (this.active) this.active.model = this.model;
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
        session: null,
        sessionSig: "",
        streaming: false,
        stopped: false,
        pendingPerm: null,
        queue: [],
        pendingEl: null,
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
      session: null,
      sessionSig: "",
      streaming: false,
      stopped: false,
      pendingPerm: null,
      queue: [],
      pendingEl: null,
    };
  }

  private saveActive(): void {
    if (!this.active) return;
    this.active.provider = this.provider;
    this.active.model = this.model;
  }

  private newConversation(): void {
    if (this.galleryEl) this.hideGallery();
    if (this.capsEl) this.hideCapabilities();
    // Keep other conversations (and their live sessions) alive — parallel.
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    const c = this.makeConvo();
    this.convos.push(c);
    this.switchTo(c);
    this.persist();
  }

  private switchTo(c: Convo): void {
    if (c === this.active) return;
    if (this.capsEl) this.hideCapabilities();
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.active = c;
    this.provider = c.provider;
    this.model = c.model;
    this.listWrap.empty();
    this.listWrap.appendChild(c.listEl);
    if (c.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.updateUsage(null);
    this.scrollConvo(c);
  }

  /** Reflect the active conversation's streaming state on the send button. */
  private syncSendButton(): void {
    const on = this.streaming;
    this.sendBtn.empty();
    setIcon(this.sendBtn, on ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-streaming", on);
  }

  private toggleGallery(): void {
    if (this.galleryEl) this.hideGallery();
    else {
      if (this.capsEl) this.hideCapabilities();
      this.showGallery();
    }
  }

  private hideGallery(): void {
    this.galleryEl?.remove();
    this.galleryEl = null;
    this.listEl.show();
    this.composerEl.show();
  }

  /* -------------------------- capabilities -------------------------- */

  private toggleCapabilities(): void {
    if (this.capsEl) this.hideCapabilities();
    else this.showCapabilities();
  }

  private hideCapabilities(): void {
    this.capsEl?.remove();
    this.capsEl = null;
    this.listEl.show();
  }

  private showCapabilities(): void {
    if (this.galleryEl) this.hideGallery();
    this.listEl.hide();
    const wrap = this.listWrap.createDiv({ cls: "mva-gallery-wrap" });
    this.capsEl = wrap;
    void renderCapabilitiesPanel(wrap, this.app, this.plugin.settings, {
      provider: this.provider,
      model: this.model,
      onOpenNote: (p) => {
        this.hideCapabilities();
        this.openNote(p);
      },
    });
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
      attr: { rows: "2", placeholder: "Message the agent…   ⏎ send · ⇧⏎ newline" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(); // send() queues if the active conversation is streaming
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

  private static readonly EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

  private buildToolbar(bar: HTMLElement): void {
    const tb = bar.createDiv({ cls: "mva-toolbar" });
    const s = this.plugin.settings;

    // Provider (type) + model selects — all controls live in this bottom bar.
    this.providerSelect = tb.createEl("select", { cls: "mva-tb-sel", attr: { "aria-label": "Provider" } });
    for (const id of ["claude", "codex"] as ProviderId[]) {
      this.providerSelect.createEl("option", { text: ADAPTERS[id].displayName }).value = id;
    }
    this.providerSelect.onchange = () => this.onProviderChange(this.providerSelect.value as ProviderId);

    this.modelSelect = tb.createEl("select", { cls: "mva-tb-sel", attr: { "aria-label": "Model" } });
    this.modelSelect.onchange = () => {
      this.model = this.modelSelect.value;
      this.persistModel();
    };

    this.buildEffort(tb);

    const perm = this.toolbarSelect(tb, "Permissions", [
      ["default", "Ask"],
      ["acceptEdits", "Accept edits"],
      ["plan", "Plan"],
      ["bypassPermissions", "Bypass"],
    ]);
    perm.value = s.permissionMode;
    perm.onchange = () => {
      s.permissionMode = perm.value as typeof s.permissionMode;
      void this.plugin.saveSettings();
    };

    const caps = tb.createEl("button", { cls: "mva-tb-icon", attr: { "aria-label": "Capabilities" } });
    setIcon(caps, "layout-dashboard");
    caps.onclick = () => this.toggleCapabilities();

    tb.createDiv({ cls: "mva-spacer" }).style.flex = "1";
    this.usageEl = tb.createDiv({ cls: "mva-usage", attr: { "aria-label": "Context used" } });
  }

  /** Effort control: a chip that opens a Faster→Smarter dotted popover. */
  private buildEffort(tb: HTMLElement): void {
    const s = this.plugin.settings;
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
    const wrap = tb.createDiv({ cls: "mva-eff" });
    const trigger = wrap.createDiv({ cls: "mva-tb-chip", attr: { "aria-label": "Effort" } });
    const pop = wrap.createDiv({ cls: "mva-eff-pop" });
    pop.hide();

    const head = pop.createDiv({ cls: "mva-eff-head" });
    head.createSpan({ cls: "mva-eff-h", text: "Effort" });
    head.createSpan({ cls: "mva-eff-v" });
    const help = head.createSpan({ cls: "mva-eff-help", attr: { title: "Higher effort = more reasoning, slower replies." } });
    setIcon(help, "help-circle");
    const ends = pop.createDiv({ cls: "mva-eff-ends" });
    ends.createSpan({ text: "Faster" });
    ends.createSpan({ text: "Smarter" });
    const dots = pop.createDiv({ cls: "mva-eff-dots" });

    let idx = Math.max(0, ChatView.EFFORTS.indexOf(s.effort || "default"));
    const render = () => {
      const label = cap(ChatView.EFFORTS[idx]);
      trigger.setText(`Effort: ${label}`);
      (pop.querySelector(".mva-eff-v") as HTMLElement)?.setText(label);
      Array.from(dots.children).forEach((d, i) => {
        d.toggleClass("is-on", i < idx);
        d.toggleClass("is-thumb", i === idx);
      });
    };
    ChatView.EFFORTS.forEach((e, i) => {
      const d = dots.createSpan({ cls: "mva-eff-dot", attr: { "aria-label": cap(e) } });
      d.onclick = () => {
        idx = i;
        s.effort = ChatView.EFFORTS[i];
        void this.plugin.saveSettings();
        render();
      };
    });
    render();

    let open = false;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) close();
    };
    const close = () => {
      open = false;
      pop.hide();
      document.removeEventListener("click", onDoc, true);
    };
    trigger.onclick = (e) => {
      e.stopPropagation();
      if (open) return close();
      open = true;
      pop.show();
      document.addEventListener("click", onDoc, true);
    };
    // Ensure the document listener is dropped if the view unloads while open.
    this.register(() => close());
  }

  private updateUsage(u: ContextUsage | null): void {
    if (!this.usageEl) return;
    if (!u || !u.total) {
      this.usageEl.setText("");
      this.usageEl.removeClass("is-warn");
      return;
    }
    const pct = Math.min(100, Math.round((u.used / u.total) * 100));
    this.usageEl.setText(`${pct}% ctx`);
    this.usageEl.toggleClass("is-warn", pct >= 80);
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
    this.renderSurfacing(empty);
  }

  /** Surface notes related to the active note (toggleable). */
  private renderSurfacing(empty: HTMLElement): void {
    if (!this.plugin.settings.featureSurfacing) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const related = relatedNotes(this.app, file, 5);
    if (!related.length) return;
    const wrap = empty.createDiv({ cls: "mva-surface" });
    wrap.createDiv({ cls: "mva-surface-label", text: `Related to ${noteBasename(file.path)}` });
    const row = wrap.createDiv({ cls: "mva-surface-chips" });
    for (const p of related) {
      const chip = row.createDiv({ cls: "mva-chip mva-surface-chip" });
      setIcon(chip.createSpan({ cls: "mva-chip-icon" }), "file-text");
      chip.createSpan({ cls: "mva-chip-label", text: noteBasename(p) });
      chip.onclick = () => {
        if (!this.manualAttached.includes(p)) this.manualAttached.push(p);
        this.refreshContext();
        this.inputEl.focus();
      };
    }
  }

  private clearEmptyState(c: Convo = this.active): void {
    c.listEl.querySelector(".mva-empty")?.remove();
  }

  private refreshNeighborhood(): void {
    if (!this.neighborhoodEl) return;
    if (!this.plugin.settings.featureNeighborhood) {
      this.neighborhoodEl.empty();
      this.neighborhoodEl.toggleClass("is-hidden", true);
      return;
    }
    renderNeighborhoodPanel(this.neighborhoodEl, this.app, this.app.workspace.getActiveFile(), (p) =>
      this.openNote(p)
    );
  }

  /** Re-render the empty state (surfacing) when the active note changes. */
  private refreshSurfacing(): void {
    if (this.listEl.querySelector(".mva-empty")) {
      this.listEl.empty();
      this.renderEmptyState();
    }
  }

  /** Rebuild a conversation's DOM from its persisted messages. */
  private renderConvoDom(c: Convo): void {
    c.listEl.empty();
    let lastUser = "";
    for (const m of c.messages) {
      if (m.role === "user") {
        lastUser = m.text;
        const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
        void MarkdownRenderer.render(this.app, m.text, el.createDiv({ cls: "mva-bubble" }), "", this);
      } else {
        const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
        const body = el.createDiv({ cls: "mva-assistant-body" });
        let full = "";
        const sources = new Set<string>();
        for (const s of m.segments) {
          if (s.t === "text") {
            void MarkdownRenderer.render(this.app, s.md, body.createDiv({ cls: "mva-bubble" }), "", this);
            full += s.md;
          } else {
            const refs = this.createToolCard(body, s.name, s.input);
            this.finishToolCard(refs, s.ok !== false, s.output);
            const fp = toolFilePath(s.name, s.input);
            if (fp && s.name === "Read") sources.add(fp);
          }
        }
        this.attachSources(el, sources);
        if (full.trim()) this.attachActions(el, full, lastUser || undefined);
      }
    }
  }

  private addUserTurn(c: Convo, text: string): void {
    this.clearEmptyState(c);
    if (c.title === "New chat") c.title = text.slice(0, 48);
    c.messages.push({ role: "user", text });
    const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
    void MarkdownRenderer.render(this.app, text, el.createDiv({ cls: "mva-bubble" }), "", this);
    this.scrollConvo(c);
  }

  private addAssistantTurn(c: Convo, userText: string): AssistantCtx {
    this.clearEmptyState(c);
    const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
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
      userText,
      thinkingEl: thinking,
      reasonEl: null,
      reasonBody: null,
      reasonRaw: "",
      sources: new Set(),
      touched: [],
      convo: c,
      renderTimer: null,
    };
    this.scrollConvo(c);
    return ctx;
  }

  private appendReasoning(ctx: AssistantCtx, text: string): void {
    this.dropThinking(ctx);
    if (!ctx.reasonEl) {
      const block = ctx.bodyEl.createDiv({ cls: "mva-reason is-collapsed" });
      const head = block.createDiv({ cls: "mva-reason-head" });
      setIcon(head.createSpan({ cls: "mva-reason-chevron" }), "chevron-right");
      head.createSpan({ cls: "mva-reason-label", text: "Reasoning" });
      head.onclick = () => block.toggleClass("is-collapsed", !block.hasClass("is-collapsed"));
      ctx.reasonBody = block.createDiv({ cls: "mva-reason-body" });
      ctx.reasonEl = block;
    }
    ctx.reasonRaw += text;
    ctx.reasonBody?.setText(ctx.reasonRaw);
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
    let md = ctx.curRaw || "";
    // Wikilink-ify only on the final render, scoped to the notes touched this turn.
    if (!streaming && this.plugin.settings.featureWikilinkify) {
      md = wikilinkify(md, [...ctx.sources, ...ctx.touched.map((t) => t.path)]);
    }
    el.empty();
    void MarkdownRenderer.render(this.app, md, el, "", this).then(() => {
      if (streaming && el.isConnected) el.createSpan({ cls: "mva-caret" });
    });
  }

  private scheduleRender(ctx: AssistantCtx): void {
    if (ctx.renderTimer !== null) return;
    ctx.renderTimer = window.setTimeout(() => {
      ctx.renderTimer = null;
      this.renderText(ctx, true);
      this.scrollConvo(ctx.convo);
    }, 60);
  }

  private flushRender(ctx: AssistantCtx): void {
    if (ctx.renderTimer !== null) {
      window.clearTimeout(ctx.renderTimer);
      ctx.renderTimer = null;
    }
    this.renderText(ctx, false);
  }

  private attachActions(turnEl: HTMLElement, text: string, retryText?: string, convo?: Convo): void {
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

    if (retryText) {
      const retry = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Retry" } });
      setIcon(retry, "refresh-cw");
      const target = convo ?? this.active;
      retry.onclick = () => {
        if (target.streaming) return;
        void this.runTurn(target, retryText);
      };
    }
  }

  /** Render a clickable "Sources" footer from the notes the agent read. */
  private attachSources(turnEl: HTMLElement, sources: Set<string>): void {
    if (sources.size === 0) return;
    const bar = turnEl.createDiv({ cls: "mva-sources" });
    bar.createSpan({ cls: "mva-sources-label", text: "Sources" });
    for (const path of sources) {
      const chip = bar.createSpan({ cls: "mva-source-chip", text: path.split("/").pop() ?? path });
      chip.onclick = () => this.openNote(path);
    }
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
    this.scrollConvo(ctx.convo);
  }

  private resolveToolCard(ctx: AssistantCtx, id: string, ok: boolean, output: string): void {
    const card = ctx.cards.get(id);
    const seg = ctx.segById.get(id);
    if (seg && seg.t === "tool") {
      seg.ok = ok;
      seg.output = output;
    }
    if (!card) return;
    this.finishToolCard(card, ok, output);
    this.scrollConvo(ctx.convo);
  }

  /* -------------------------- permissions --------------------------- */

  private addPermissionCard(
    ctx: AssistantCtx,
    c: Convo,
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
    let done = false;
    const finishCard = (
      verdict: string,
      d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }
    ) => {
      if (done) return;
      done = true;
      c.pendingPerm = null;
      card.addClass("is-resolved");
      actions.empty();
      card.createDiv({ cls: "mva-perm-verdict", text: verdict });
      resolve(d);
    };
    const settle = (
      d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }
    ) => finishCard(d.behavior === "deny" ? "Denied" : d.remember ? "Always allowed" : "Allowed", d);
    // If the user presses Stop while this card is open, cancel it (the provider
    // side is already unblocked via interrupt → deny).
    c.pendingPerm = () => finishCard("Cancelled", { behavior: "deny", message: "Stopped." });
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Allow once" }).onclick = () =>
      settle({ behavior: "allow" });
    actions.createEl("button", { cls: "mva-btn", text: "Always allow" }).onclick = () => {
      c.allow.add(tool);
      settle({ behavior: "allow", remember: true });
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Deny" }).onclick = () =>
      settle({ behavior: "deny", message: "Denied by user." });
    this.scrollConvo(c);
  }

  /* ----------------------------- send ------------------------------- */

  private scrollToBottom(): void {
    this.scrollConvo(this.active);
  }

  /** Scroll a conversation to the bottom — only if it's the visible one. */
  private scrollConvo(c: Convo): void {
    if (c === this.active) this.listEl.scrollTop = this.listEl.scrollHeight;
  }

  private setStreaming(c: Convo, on: boolean): void {
    c.streaming = on;
    if (c === this.active) this.syncSendButton();
  }

  private stop(): void {
    const c = this.active;
    c.stopped = true;
    c.queue = [];
    this.renderQueue(c);
    c.pendingPerm?.(); // cancel any open permission card
    c.session?.interrupt();
  }

  private send(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.autoGrow();
    const c = this.active;
    if (c.streaming) {
      c.queue.push(text); // queue while a turn is running
      this.renderQueue(c);
    } else {
      void this.runTurn(c, text);
    }
  }

  /** Render queued (not-yet-sent) messages as removable chips. */
  private renderQueue(c: Convo): void {
    if (!c.queue.length) {
      c.pendingEl?.remove();
      c.pendingEl = null;
      return;
    }
    if (!c.pendingEl) c.pendingEl = c.listEl.createDiv({ cls: "mva-queue" });
    c.pendingEl.empty();
    c.queue.forEach((q, i) => {
      const row = c.pendingEl!.createDiv({ cls: "mva-queued" });
      setIcon(row.createSpan({ cls: "mva-queued-icon" }), "clock");
      row.createSpan({ cls: "mva-queued-text", text: q });
      const x = row.createSpan({ cls: "mva-chip-x", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      x.onclick = () => {
        c.queue.splice(i, 1);
        this.renderQueue(c);
      };
    });
    this.scrollConvo(c);
  }

  private async runTurn(c: Convo, text: string): Promise<void> {
    const paths = c === this.active ? this.contextPaths() : [];
    const message = paths.length
      ? `Context notes:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n${text}`
      : text;

    this.addUserTurn(c, text);
    const ctx = this.addAssistantTurn(c, text);
    c.stopped = false;
    this.setStreaming(c, true);

    const adapter = ADAPTERS[c.provider];
    const s = this.plugin.settings;

    // Watchdog: reset on every event; fire if the turn stalls with no output.
    let timedOut = false;
    let watchdog: number | null = null;
    const bump = () => {
      if (watchdog !== null) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        timedOut = true;
        c.session?.interrupt();
      }, IDLE_TIMEOUT);
    };

    const onEvent = (e: AgentEvent) => {
      bump();
      switch (e.kind) {
        case "text-delta":
          this.appendText(ctx, e.text);
          break;
        case "thinking-delta":
          this.appendReasoning(ctx, e.text);
          break;
        case "tool-call-start": {
          this.addToolCard(ctx, e.id, e.name, e.input);
          const fp = toolFilePath(e.name, e.input);
          if (fp) {
            const writeTools = /Write|Edit|MultiEdit|append_to_note|update_frontmatter|create_note|add_links/;
            const kind = writeTools.test(e.name) ? "write" : "read";
            if (kind === "read") ctx.sources.add(fp);
            if (!ctx.touched.some((t) => t.path === fp)) ctx.touched.push({ path: fp, kind });
          }
          break;
        }
        case "tool-call-result":
          this.resolveToolCard(ctx, e.id, e.ok, e.output);
          break;
        case "permission-request": {
          const isRead = READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool);
          if ((s.autoAllowRead && isRead) || c.allow.has(e.tool)) {
            e.resolve({ behavior: "allow" });
          } else if (OBSIDIAN_MEMORY_TOOLS.has(e.tool) && !s.memoryWriteEnabled) {
            e.resolve({ behavior: "deny", message: "Memory writing is disabled in Kortex settings." });
          } else {
            this.addPermissionCard(ctx, c, e.tool, e.input, e.resolve);
          }
          break;
        }
        case "usage":
          if (c === this.active) this.updateUsage(e.usage);
          break;
        case "turn-end":
          if (e.sessionId) c.sessionId = e.sessionId;
          break;
        case "error":
          this.dropThinking(ctx);
          ctx.curTextEl = null;
          ctx.curTextSeg = null;
          if (c.stopped) {
            // User pressed Stop — the provider reports an execution error as it
            // unwinds; render it as a clean stop, not a scary error.
            ctx.el.addClass("mva-aborted");
            if (!ctx.fullText && ctx.cards.size === 0) {
              ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
            }
          } else {
            this.renderError(ctx, e.message);
          }
          break;
      }
    };

    try {
      bump();
      const session = await this.ensureSession(c);
      await session.send(message, onEvent);
      // Stop the watchdog before reading `timedOut` so a timer that fires in the
      // gap between send() resolving and `finally` can't trip a false timeout.
      if (watchdog !== null) {
        window.clearTimeout(watchdog);
        watchdog = null;
      }
      this.flushRender(ctx);
      if (timedOut && !ctx.fullText && ctx.cards.size === 0) {
        this.renderError(ctx, `No response — timed out after ${IDLE_TIMEOUT / 1000}s.`);
      }
      this.attachSources(ctx.el, ctx.sources);
      if (s.featureMiniGraph && ctx.touched.length) {
        renderMiniGraph(ctx.el.createDiv({ cls: "mva-graph-wrap" }), ctx.touched, (p) => this.openNote(p));
      }
      if (ctx.fullText.trim()) this.attachActions(ctx.el, ctx.fullText, text, c);
    } catch (err) {
      this.flushRender(ctx);
      this.dropSession(c); // a failed turn likely poisoned the session
      if (isAbort(err) || timedOut) {
        ctx.el.addClass("mva-aborted");
        if (!ctx.fullText && ctx.cards.size === 0) {
          ctx.bodyEl.createSpan({ cls: "mva-faint", text: timedOut ? "Timed out." : "Stopped." });
        }
      } else {
        this.dropThinking(ctx);
        const msg = describeError(err, adapter.displayName);
        if (!ctx.bodyEl.querySelector(".mva-inline-error, .mva-onboard")) this.renderError(ctx, msg);
        new Notice(msg);
        // Don't replay queued messages into a broken session — they'd just re-fail.
        if (c.queue.length) {
          c.queue = [];
          this.renderQueue(c);
        }
      }
    } finally {
      if (watchdog !== null) window.clearTimeout(watchdog);
      c.pendingPerm = null;
      // Confirm a user-initiated stop when nothing substantive was rendered.
      if (
        c.stopped &&
        !ctx.fullText.trim() &&
        !ctx.el.querySelector(".mva-faint, .mva-inline-error, .mva-onboard")
      ) {
        ctx.el.addClass("mva-aborted");
        ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
      }
      if (ctx.segments.length) c.messages.push({ role: "assistant", segments: ctx.segments });
      c.updatedAt = Date.now();
      this.setStreaming(c, false);
      this.persist();
      this.scrollConvo(c);
      // Drain the queue: run the next message in this conversation.
      if (c.queue.length) {
        const next = c.queue.shift()!;
        this.renderQueue(c);
        void this.runTurn(c, next);
      }
    }
  }

  /** Inline error, upgraded to a setup card when the CLI isn't ready. */
  private renderError(ctx: AssistantCtx, message: string): void {
    if (/not found|not logged in|sign in|run it once/i.test(message)) {
      const card = ctx.bodyEl.createDiv({ cls: "mva-onboard" });
      setIcon(card.createDiv({ cls: "mva-onboard-icon" }), "plug-zap");
      card.createDiv({ cls: "mva-onboard-title", text: `${ADAPTERS[this.provider].displayName} isn't ready` });
      card.createDiv({ cls: "mva-onboard-msg", text: message });
      const steps = card.createEl("ol", { cls: "mva-onboard-steps" });
      steps.createEl("li", { text: `Open a terminal and run \`${this.provider}\` once to sign in.` });
      steps.createEl("li", { text: "If it's installed elsewhere, set the binary path in settings." });
      const btn = card.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Open settings" });
      btn.onclick = () => this.openSettings();
      return;
    }
    ctx.bodyEl.createDiv({ cls: "mva-inline-error", text: `⚠️ ${message}` });
  }

  private openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById("kortex");
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
