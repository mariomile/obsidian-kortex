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
  Keymap,
} from "obsidian";
import { Autocomplete, type AcItem } from "./ui/autocomplete";
import type KortexPlugin from "./main";
import { resolveCli, describeError, isAbort } from "./cli";
import { ADAPTERS } from "./providers/registry";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  ProviderId,
} from "./providers/types";
import { toolMeta, toolFilePath, renderToolDetail, READ_ONLY_TOOLS } from "./ui/tools";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS, OBSIDIAN_MEMORY_TOOLS } from "./obsidian/tools";
import { readBootContext } from "./obsidian/memory";
import { relatedNotes, basename as noteBasename } from "./obsidian/graph";
import { renderMiniGraph, wikilinkify, type TouchedNote } from "./ui/graph-view";
import { renderCapabilitiesPanel } from "./ui/capabilities";

export const VIEW_TYPE = "kortex-view";

const MAX_CONVOS = 30;
const MAX_PERSIST_OUTPUT = 2000;

/** Semantic risk modifier class for a toolbar selector option/chip ("" = neutral). */
type RiskLevel = "" | "is-caution" | "is-danger";

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  return "image/png";
}

interface ToolCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  bodyEl: HTMLElement;
}

/* ----- persisted data model ----- */
type Segment =
  | { t: "text"; md: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string };
/** Per-turn file snapshot for code rewind: path → content before the turn (null = didn't exist). */
type Checkpoint = Map<string, string | null>;
type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; checkpoint?: Checkpoint };

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
  queue: { text: string; images?: ImageAttachment[] }[];
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
  /** Live TodoWrite panel for this turn (re-rendered on each update). */
  todosEl: HTMLElement | null;
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
  private obsidianAlwaysLoad = true;
  private memoryPreamble = "";

  private convos: Convo[] = [];
  private active!: Convo;
  /** Ids of conversations shown in the tab bar (ordered). Subset of `convos`. */
  private openTabs: string[] = [];

  private tabsEl!: HTMLElement;
  private listWrap!: HTMLElement;
  private composerEl!: HTMLElement;
  private galleryEl: HTMLElement | null = null;
  private capsEl: HTMLElement | null = null;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private brandDot!: HTMLElement;
  // Toolbar selector chips (Permission-style popovers) expose a refresh fn each.
  private refreshProviderChip: () => void = () => {};
  private refreshModelChip: () => void = () => {};
  private refreshPermChipFn: () => void = () => {};
  private contextEl!: HTMLElement;
  private excludeActiveNote = false;
  private manualAttached: string[] = [];
  private pendingImages: ImageAttachment[] = [];
  private imagesEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: KortexPlugin) {
    super(leaf);
    this.provider = plugin.settings.provider;
    this.model = this.provider === "claude" ? plugin.settings.claudeModel : plugin.settings.codexModel;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Exo";
  }
  getIcon(): string {
    return "sparkle";
  }

  private get listEl(): HTMLElement {
    return this.active.listEl;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("mva-root");
    this.buildHeader(root);
    this.tabsEl = root.createDiv({ cls: "mva-tabs" });
    this.listWrap = root.createDiv({ cls: "mva-list-wrap" });
    // Wire up link clicks in rendered markdown (MarkdownRenderer doesn't do this for custom views).
    this.registerDomEvent(this.listWrap, "click", (e) => {
      const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
      if (!a) return;
      const external = a.getAttr("href") ?? "";
      if (a.classList.contains("internal-link")) {
        e.preventDefault();
        const href = a.getAttr("data-href") || a.getAttr("href") || a.textContent || "";
        if (href) void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(e));
      } else if (/^https?:\/\//.test(external)) {
        e.preventDefault();
        window.open(external, "_blank");
      }
    });
    this.buildComposer(root);
    await this.restore();
    this.refreshContext();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshContext();
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
      s.autoCompactEnabled,
      s.contextSavingMode,
      s.codexSandbox,
      s.codexApproval,
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
    // Rebuild the server if the always-load (context-saving) preference changed.
    const wantAlwaysLoad = !s.contextSavingMode;
    if (useObsidian && (!this.obsidianServer || this.obsidianAlwaysLoad !== wantAlwaysLoad)) {
      this.obsidianServer = createObsidianToolServer(this.app, wantAlwaysLoad);
      this.obsidianAlwaysLoad = wantAlwaysLoad;
    }

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
      autoCompact: s.autoCompactEnabled && c.provider === "claude",
      sandboxMode: s.codexSandbox,
      approvalPolicy: s.codexApproval,
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
    header.createSpan({ cls: "mva-brand-name", text: "Exo" });
    header.createDiv({ cls: "mva-spacer" }).style.flex = "1";

    const caps = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Capabilities" } });
    setIcon(caps, "blocks");
    caps.onclick = () => this.toggleCapabilities();

    const histBtn = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "History" } });
    setIcon(histBtn, "history");
    histBtn.onclick = () => this.toggleGallery();

    const newChat = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    newChat.onclick = () => this.newConversation();
  }

  private onProviderChange(next: ProviderId): void {
    if (next === this.provider) return;
    if (this.streaming) {
      new Notice("Can't switch provider while a reply is streaming.");
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

  /** All selectable model ids for the current provider (built-in + custom + current). */
  private modelChoices(): { id: string; label: string }[] {
    const a = ADAPTERS[this.provider];
    const out: { id: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const m of a.models()) {
      out.push({ id: m.id, label: m.label });
      seen.add(m.id);
    }
    const custom = this.provider === "claude"
      ? this.plugin.settings.claudeCustomModels
      : this.plugin.settings.codexCustomModels;
    for (const id of custom.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: id });
    }
    if (this.model && !seen.has(this.model)) out.push({ id: this.model, label: this.model });
    return out;
  }

  private modelLabel(): string {
    const found = this.modelChoices().find((m) => m.id === this.model);
    return found?.label || this.model || "Model";
  }

  private refreshProviderUI(): void {
    const a = ADAPTERS[this.provider];
    this.brandDot.style.background = a.brandColor;
    this.brandDot.style.color = a.brandColor;
    this.contentEl.style.setProperty("--mva-brand", a.brandColor);
    this.refreshProviderChip();
    this.refreshModelChip();
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

    const byId = new Map(this.convos.map((c) => [c.id, c]));
    const s = this.plugin.settings;
    if (this.convos.length === 0) {
      this.active = this.makeConvo();
      this.convos.push(this.active);
    } else {
      this.active = byId.get(s.activeTabId) ?? this.convos[this.convos.length - 1];
      this.provider = this.active.provider;
      this.model = this.active.model;
    }

    // Restore the open-tab set (filter to still-existing convos); fall back to active.
    this.openTabs = (s.openTabIds ?? []).filter((id) => byId.has(id));
    if (!this.openTabs.includes(this.active.id)) this.openTabs.push(this.active.id);
    if (this.openTabs.length === 0) this.openTabs = [this.active.id];

    this.listWrap.empty();
    this.listWrap.appendChild(this.active.listEl);
    if (this.active.messages.length === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.renderTabs();
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
    this.openTabs.push(c.id);
    this.switchTo(c);
    this.persist();
  }

  private switchTo(c: Convo): void {
    if (c === this.active) return;
    if (this.capsEl) this.hideCapabilities();
    this.saveActive();
    if (!this.convos.includes(this.active)) this.convos.push(this.active);
    this.active = c;
    if (!this.openTabs.includes(c.id)) this.openTabs.push(c.id);
    this.provider = c.provider;
    this.model = c.model;
    this.listWrap.empty();
    this.listWrap.appendChild(c.listEl);
    if (c.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.updateUsage(null);
    this.renderTabs();
    this.persistTabs();
    this.scrollConvo(c);
  }

  /* ----------------------------- tab bar ---------------------------- */

  /** Render the open-conversation tab strip. */
  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.empty();
    const ids = this.openTabs.filter((id) => this.convos.some((c) => c.id === id));
    this.openTabs = ids;
    // A lone empty tab needs no bar — keep the chrome minimal.
    if (ids.length <= 1) {
      this.tabsEl.addClass("is-hidden");
      return;
    }
    this.tabsEl.removeClass("is-hidden");
    for (const id of ids) {
      const c = this.convos.find((x) => x.id === id);
      if (!c) continue;
      const tab = this.tabsEl.createDiv({ cls: "mva-tab" + (c === this.active ? " is-active" : "") });
      const dot = tab.createSpan({ cls: "mva-tab-dot" });
      dot.style.background = ADAPTERS[c.provider].brandColor;
      if (c.streaming) tab.addClass("is-streaming");
      tab.createSpan({ cls: "mva-tab-title", text: c.title || "New chat" });
      const x = tab.createSpan({ cls: "mva-tab-x", attr: { "aria-label": "Close tab" } });
      setIcon(x, "x");
      x.onclick = (e) => {
        e.stopPropagation();
        this.closeTab(c);
      };
      tab.onclick = () => this.switchTo(c);
    }
    const add = this.tabsEl.createDiv({ cls: "mva-tab-add", attr: { "aria-label": "New tab" } });
    setIcon(add, "plus");
    add.onclick = () => this.newConversation();
  }

  /** Close a tab (the conversation stays in history; reopen from the gallery). */
  private closeTab(c: Convo): void {
    const idx = this.openTabs.indexOf(c.id);
    if (idx === -1) return;
    this.openTabs.splice(idx, 1);
    this.dropSession(c); // free the live session; resumable from history
    if (c === this.active) {
      const nextId = this.openTabs[idx] ?? this.openTabs[idx - 1] ?? this.openTabs[this.openTabs.length - 1];
      const next = nextId ? this.convos.find((x) => x.id === nextId) : undefined;
      if (next) {
        this.switchTo(next); // this.active is still `c` here, so this runs
      } else {
        // No tabs left — open a fresh one.
        const fresh = this.makeConvo();
        this.convos.push(fresh);
        this.openTabs.push(fresh.id);
        this.switchTo(fresh);
      }
    } else {
      this.renderTabs();
      this.persistTabs();
    }
    this.persist();
  }

  /** Fork the active conversation into a new tab (full transcript + resume id). */
  private forkConversation(src: Convo): void {
    const c = this.makeConvo();
    c.title = src.title ? `${src.title} (fork)` : "Fork";
    c.provider = src.provider;
    c.model = src.model;
    c.sessionId = src.sessionId; // best-effort: continue with the same context
    c.messages = src.messages.map((m) =>
      m.role === "assistant" ? { role: "assistant", segments: [...m.segments] } : { ...m }
    );
    c.updatedAt = Date.now();
    this.renderConvoDom(c);
    this.convos.push(c);
    this.openTabs.push(c.id);
    this.switchTo(c);
    this.persist();
    new Notice("Forked conversation into a new tab.");
  }

  /** Clear the active conversation to a fresh session, keeping the tab. */
  private newSessionInTab(): void {
    const c = this.active;
    this.dropSession(c);
    c.messages = [];
    c.sessionId = undefined;
    c.allow.clear();
    c.queue = [];
    c.title = "New chat";
    c.updatedAt = Date.now();
    c.listEl.empty();
    c.pendingEl = null;
    this.renderEmptyState();
    this.updateUsage(null);
    this.renderTabs();
    this.persist();
  }

  private persistTabs(): void {
    this.plugin.settings.openTabIds = [...this.openTabs];
    this.plugin.settings.activeTabId = this.active?.id ?? "";
    void this.plugin.saveSettings();
  }

  /* ----- command entry points (called from main.ts) ----- */
  cmdNewTab(): void {
    this.newConversation();
  }
  cmdNewSession(): void {
    this.newSessionInTab();
  }
  cmdCloseTab(): void {
    this.closeTab(this.active);
  }
  cmdForkConversation(): void {
    this.forkConversation(this.active);
  }
  cmdCompact(): void {
    this.compactActive();
  }

  /** Toggle plan mode (Shift+Tab) — explore & propose before editing. */
  private togglePlanMode(): void {
    const s = this.plugin.settings;
    const next = s.permissionMode === "plan" ? "default" : "plan";
    s.permissionMode = next;
    void this.plugin.saveSettings();
    this.refreshPermChipFn();
    this.active.session?.setPermissionMode?.(next);
    new Notice(next === "plan" ? "Plan mode on — the agent will propose before acting." : "Plan mode off.");
  }
  cmdTogglePlan(): void {
    this.togglePlanMode();
  }

  /** Manually compact the active conversation's context (Claude). */
  private compactActive(): void {
    const c = this.active;
    if (c.provider !== "claude") {
      new Notice("Compact is available for Claude.");
      return;
    }
    if (c.streaming) {
      new Notice("Wait for the current turn to finish, then compact.");
      return;
    }
    if (!c.session?.compact) {
      new Notice("Send a message first — nothing to compact yet.");
      return;
    }
    c.session.compact();
    new Notice("Compacting the conversation…");
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
    this.imagesEl = bar.createDiv({ cls: "mva-images is-hidden" });

    // One unified input box (the only surface): textarea on top, controls at the bottom.
    const box = bar.createDiv({ cls: "mva-inputbox" });
    this.inputEl = box.createEl("textarea", {
      cls: "mva-input",
      attr: { rows: "3", placeholder: "Message the agent…" },
    });
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("paste", (e) => this.onPaste(e));
    bar.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        bar.addClass("is-drop");
      }
    });
    bar.addEventListener("dragleave", () => bar.removeClass("is-drop"));
    bar.addEventListener("drop", (e) => {
      bar.removeClass("is-drop");
      this.onDrop(e);
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        this.togglePlanMode();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(); // send() queues if the active conversation is streaming
      }
    });

    new Autocomplete(this.inputEl, box, [
      { trigger: "/", getItems: (q) => this.slashItems(q) },
      { trigger: "$", getItems: (q) => this.skillItems(q) },
      { trigger: "@", getItems: (q) => this.atItems(q) },
    ]);

    this.buildToolbar(box);
  }

  /* ----------------------------- images ----------------------------- */

  private onPaste(e: ClipboardEvent): void {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      void this.attachImages(files);
    }
  }

  private onDrop(e: DragEvent): void {
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      void this.attachImages(files);
    }
  }

  private async attachImages(files: Blob[]): Promise<void> {
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const dataB64 = arrayBufferToBase64(buf);
        this.pendingImages.push({
          mediaType: (f as File).type || "image/png",
          dataB64,
          name: (f as File).name || "pasted image",
        });
      } catch {
        new Notice("Couldn't read an image.");
      }
    }
    this.renderImageStrip();
  }

  /** Resolve `![[image]]` embeds in the text to base64 attachments (Obsidian-native). */
  private async embeddedImages(text: string): Promise<ImageAttachment[]> {
    const out: ImageAttachment[] = [];
    const re = /!\[\[([^\]]+?\.(?:png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const f = this.app.metadataCache.getFirstLinkpathDest(m[1], "");
      if (!f) continue;
      try {
        const buf = await this.app.vault.readBinary(f);
        out.push({
          mediaType: extToMime(f.extension),
          dataB64: arrayBufferToBase64(buf),
          name: f.name,
        });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }

  private renderImageStrip(): void {
    this.imagesEl.empty();
    this.imagesEl.toggleClass("is-hidden", this.pendingImages.length === 0);
    this.pendingImages.forEach((img, i) => {
      const chip = this.imagesEl.createDiv({ cls: "mva-img-chip" });
      const thumb = chip.createEl("img", { cls: "mva-img-thumb" });
      thumb.src = `data:${img.mediaType};base64,${img.dataB64}`;
      const x = chip.createSpan({ cls: "mva-img-x", attr: { "aria-label": "Remove image" } });
      setIcon(x, "x");
      x.onclick = () => {
        this.pendingImages.splice(i, 1);
        this.renderImageStrip();
      };
    });
  }

  /* --------------------------- autocomplete ------------------------- */

  private slashCache: { commands: string[]; skills: string[]; agents: string[] } | null = null;

  private async loadSlash(): Promise<{ commands: string[]; skills: string[]; agents: string[] }> {
    if (this.slashCache) return this.slashCache;
    const commands: string[] = [];
    const skills: string[] = [];
    const agents: string[] = [];
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
    try {
      const a = await this.app.vault.adapter.list(".claude/agents");
      for (const f of a.files) if (f.endsWith(".md")) agents.push(base(f));
    } catch {
      /* no agents dir */
    }
    this.slashCache = { commands, skills, agents };
    return this.slashCache;
  }

  /** `$` trigger — skills. */
  private async skillItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const { skills } = await this.loadSlash();
    return skills
      .filter((sk) => sk.toLowerCase().includes(q))
      .map((sk) => ({ label: sk, detail: "skill", icon: "sparkles", insert: `$${sk} ` }));
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

  private async atItems(query: string): Promise<AcItem[]> {
    const q = query.toLowerCase();
    const out: AcItem[] = [];
    // Subagents first — reference a vault agent by @mention.
    const { agents } = await this.loadSlash();
    for (const a of agents) {
      if (q && !a.toLowerCase().includes(q)) continue;
      out.push({ label: a, detail: "subagent", icon: "bot", insert: `@${a} ` });
    }
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

  private static readonly EFFORT_OPTS: [string, string][] = [
    ["default", "Default"],
    ["low", "Low"],
    ["medium", "Medium"],
    ["high", "High"],
    ["xhigh", "Extra high"],
    ["max", "Max"],
  ];
  private static effortLabel(e: string): string {
    return ChatView.EFFORT_OPTS.find(([v]) => v === e)?.[1] ?? e;
  }

  private buildToolbar(bar: HTMLElement): void {
    const tb = bar.createDiv({ cls: "mva-toolbar" });
    const s = this.plugin.settings;

    // Provider — Permission-style popover.
    this.refreshProviderChip = this.buildSelectChip(tb, {
      ariaLabel: "Provider",
      getLabel: () => ADAPTERS[this.provider].displayName,
      getOptions: () =>
        (["claude", "codex"] as ProviderId[]).map((id) => ({ value: id, label: ADAPTERS[id].displayName })),
      getCurrent: () => this.provider,
      onSelect: (v) => this.onProviderChange(v as ProviderId),
    });

    // Model — Permission-style popover (rebuilt on open; list depends on provider).
    this.refreshModelChip = this.buildSelectChip(tb, {
      ariaLabel: "Model",
      getLabel: () => this.modelLabel(),
      getOptions: () => this.modelChoices().map((m) => ({ value: m.id, label: m.label })),
      getCurrent: () => this.model,
      onSelect: (v) => {
        if (this.streaming) {
          new Notice("Can't switch model while a reply is streaming.");
          return;
        }
        this.model = v;
        this.persistModel();
      },
    });

    // Effort — Permission-style popover.
    this.buildSelectChip(tb, {
      ariaLabel: "Effort",
      getLabel: () => `Effort: ${ChatView.effortLabel(s.effort || "default")}`,
      getOptions: () => ChatView.EFFORT_OPTS.map(([value, label]) => ({ value, label })),
      getCurrent: () => s.effort || "default",
      onSelect: (v) => {
        s.effort = v;
        void this.plugin.saveSettings();
      },
    });

    // Permission — Permission-style popover with risk coloring.
    this.refreshPermChipFn = this.buildSelectChip(tb, {
      ariaLabel: "Permission mode",
      getLabel: () => `Perm: ${ChatView.permLabel(s.permissionMode)}`,
      getOptions: () =>
        ChatView.PERM_OPTS.map(([v, l]) => ({ value: v, label: l, risk: ChatView.permRisk(v) })),
      getCurrent: () => s.permissionMode,
      chipRisk: () => ChatView.permRisk(s.permissionMode),
      onSelect: (v) => {
        s.permissionMode = v as typeof s.permissionMode;
        void this.plugin.saveSettings();
        this.active.session?.setPermissionMode?.(s.permissionMode);
      },
    });

    tb.createDiv({ cls: "mva-spacer" }).style.flex = "1";
    this.usageEl = tb.createDiv({
      cls: "mva-usage",
      attr: { "aria-label": "Context used — click to compact" },
    });
    this.usageEl.onclick = () => this.compactActive();

    // Send button — lives inside the input box, right side.
    this.sendBtn = tb.createEl("button", { cls: "mva-send", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");
    this.sendBtn.onclick = () => (this.streaming ? this.stop() : void this.send());
  }

  /**
   * Generic toolbar selector — a chip that opens a Permission-style popover list.
   * Reused by provider / model / effort / permission. Returns a `refresh()` that
   * re-syncs the chip label (and risk color) after external changes.
   */
  private buildSelectChip(
    tb: HTMLElement,
    opts: {
      ariaLabel: string;
      getLabel: () => string;
      getOptions: () => { value: string; label: string; risk?: RiskLevel }[];
      getCurrent: () => string;
      onSelect: (value: string) => void;
      chipRisk?: () => RiskLevel;
    }
  ): () => void {
    const wrap = tb.createDiv({ cls: "mva-sel" });
    const chip = wrap.createDiv({ cls: "mva-sel-chip", attr: { "aria-label": opts.ariaLabel } });
    const pop = wrap.createDiv({ cls: "mva-sel-pop" });
    pop.hide();

    const refresh = () => {
      const risk = opts.chipRisk ? opts.chipRisk() : "";
      chip.className = `mva-sel-chip${risk ? ` ${risk}` : ""}`;
      chip.setText(opts.getLabel());
    };

    const buildPop = () => {
      pop.empty();
      const cur = opts.getCurrent();
      for (const o of opts.getOptions()) {
        const row = pop.createDiv({ cls: "mva-sel-opt" });
        if (o.risk) row.addClass(o.risk);
        if (o.value === cur) row.addClass("is-active");
        row.setText(o.label);
        row.onclick = () => {
          opts.onSelect(o.value);
          refresh();
          close();
        };
      }
    };

    refresh();

    let open = false;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) close();
    };
    const close = () => {
      open = false;
      pop.hide();
      document.removeEventListener("click", onDoc, true);
    };
    chip.onclick = (e) => {
      e.stopPropagation();
      if (open) return close();
      buildPop(); // rebuild fresh — option lists can change (e.g. model list per provider)
      open = true;
      pop.show();
      document.addEventListener("click", onDoc, true);
    };
    this.register(() => close());
    return refresh;
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


  /* ---- Permission chip helpers ---- */
  private static readonly PERM_OPTS: [string, string][] = [
    ["default", "Ask"],
    ["acceptEdits", "Accept edits"],
    ["plan", "Plan"],
    ["bypassPermissions", "Bypass"],
  ];
  private static permLabel(mode: string): string {
    return ChatView.PERM_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  /** Returns a CSS modifier class for risk coloring; empty string = safe mode. */
  private static permRisk(mode: string): RiskLevel {
    if (mode === "bypassPermissions") return "is-danger";
    if (mode === "acceptEdits") return "is-caution";
    return "";
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
        void MarkdownRenderer.render(this.app, m.text, el.createDiv({ cls: "mva-bubble markdown-rendered" }), "", this);
      } else {
        const el = c.listEl.createDiv({ cls: "mva-turn mva-assistant" });
        const body = el.createDiv({ cls: "mva-assistant-body" });
        let full = "";
        const sources = new Set<string>();
        for (const s of m.segments) {
          if (s.t === "text") {
            void MarkdownRenderer.render(this.app, s.md, body.createDiv({ cls: "mva-bubble markdown-rendered" }), "", this);
            full += s.md;
          } else {
            const refs = this.createToolCard(body, s.name, s.input);
            this.finishToolCard(refs, s.ok !== false, s.output);
            const fp = toolFilePath(s.name, s.input);
            if (fp && s.name === "Read") sources.add(fp);
          }
        }
        this.attachSources(el, sources);
        if (full.trim()) this.attachActions(el, full, lastUser || undefined, c);
      }
    }
  }

  private addUserTurn(c: Convo, text: string, images?: ImageAttachment[]): void {
    this.clearEmptyState(c);
    if (c.title === "New chat") {
      c.title = text.slice(0, 48) || (images?.length ? "Image" : "New chat");
      this.renderTabs(); // reflect the new title in the tab
    }
    c.messages.push({ role: "user", text });
    const el = c.listEl.createDiv({ cls: "mva-turn mva-user" });
    const bubble = el.createDiv({ cls: "mva-bubble" });
    if (images?.length) {
      const strip = bubble.createDiv({ cls: "mva-bubble-images" });
      for (const img of images) {
        strip.createEl("img", {
          cls: "mva-bubble-img",
          attr: { src: `data:${img.mediaType};base64,${img.dataB64}` },
        });
      }
    }
    if (text) void MarkdownRenderer.render(this.app, text, bubble.createDiv({ cls: "markdown-rendered" }), "", this);
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
      todosEl: null,
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
      ctx.curTextEl = ctx.bodyEl.createDiv({ cls: "mva-bubble markdown-rendered" });
      ctx.curRaw = "";
      ctx.curTextSeg = { t: "text", md: "" };
      ctx.segments.push(ctx.curTextSeg);
    }
    ctx.curRaw += text;
    ctx.curTextSeg!.md += text;
    ctx.fullText += text;
    this.scheduleRender(ctx);
  }

  /** Render/refresh the agent's TodoWrite list as a live checklist panel. */
  private renderTodos(ctx: AssistantCtx, input: unknown): void {
    const todos = (input as { todos?: Array<{ content?: string; status?: string }> })?.todos;
    if (!Array.isArray(todos)) return;
    this.dropThinking(ctx);
    ctx.curTextEl = null;
    ctx.curTextSeg = null;
    if (!ctx.todosEl) ctx.todosEl = ctx.bodyEl.createDiv({ cls: "mva-todos" });
    const el = ctx.todosEl;
    el.empty();
    const done = todos.filter((t) => t.status === "completed").length;
    const head = el.createDiv({ cls: "mva-todos-head" });
    setIcon(head.createSpan({ cls: "mva-todos-icon" }), "list-checks");
    head.createSpan({ text: `Tasks ${done}/${todos.length}` });
    for (const t of todos) {
      const row = el.createDiv({ cls: `mva-todo is-${t.status ?? "pending"}` });
      const box = row.createSpan({ cls: "mva-todo-box" });
      setIcon(
        box,
        t.status === "completed" ? "check" : t.status === "in_progress" ? "loader-2" : "circle"
      );
      row.createSpan({ cls: "mva-todo-text", text: t.content ?? "" });
    }
    this.scrollConvo(ctx.convo);
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
      // Keep at most one caret — on the element that's currently streaming.
      this.clearCarets(ctx.convo.listEl);
      if (streaming && el.isConnected) el.createSpan({ cls: "mva-caret" });
    });
  }

  /** Remove every streaming caret in a conversation's list. */
  private clearCarets(root: HTMLElement): void {
    root.querySelectorAll(".mva-caret").forEach((c) => c.remove());
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
    // Turns that end on a tool call have no curTextEl to re-render — clear directly.
    this.clearCarets(ctx.convo.listEl);
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

    const fork = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Fork into new tab" } });
    setIcon(fork, "git-compare-arrows");
    fork.onclick = () => this.forkConversation(convo ?? this.active);

    const rewind = bar.createEl("button", { cls: "mva-act", attr: { "aria-label": "Rewind here (conversation only)" } });
    setIcon(rewind, "undo-2");
    rewind.onclick = () => this.rewindTo(convo ?? this.active, turnEl);

    const rewindCode = bar.createEl("button", {
      cls: "mva-act",
      attr: { "aria-label": "Rewind code + conversation (restore files to this point)" },
    });
    setIcon(rewindCode, "history");
    rewindCode.onclick = () => void this.rewindCodeTo(convo ?? this.active, turnEl);
  }

  /** Conversation-only rewind: drop turns after this one and reset the session.
   *  Files on disk are NOT touched (a safe, non-destructive rewind). */
  private rewindTo(c: Convo, turnEl: HTMLElement): void {
    if (c.streaming) {
      new Notice("Stop the current turn before rewinding.");
      return;
    }
    const turns = Array.from(c.listEl.querySelectorAll(".mva-turn"));
    const idx = turns.indexOf(turnEl);
    if (idx < 0) return;
    c.messages = c.messages.slice(0, idx + 1);
    for (let i = turns.length - 1; i > idx; i--) turns[i].remove();
    this.dropSession(c); // next message starts a fresh session from this point
    c.sessionId = undefined;
    c.queue = [];
    this.renderQueue(c);
    c.updatedAt = Date.now();
    this.updateUsage(null);
    this.persist();
    new Notice("Rewound the conversation. Files are unchanged; the session was reset.");
  }

  /** Normalize a possibly-absolute tool path (built-in Write/Edit use absolute paths)
   *  to a vault-relative path the vault API understands. */
  private relPath(p: string): string {
    const base = this.vaultPath();
    if (base && base !== "." && p.startsWith(base + "/")) return p.slice(base.length + 1);
    return p;
  }

  /** Snapshot a file's current content before a write (null = it doesn't exist yet). */
  private async snapshot(cp: Checkpoint, rawPath: string): Promise<void> {
    const path = this.relPath(rawPath);
    if (cp.has(path)) return;
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        cp.set(path, await this.app.vault.read(f));
      } catch {
        cp.set(path, null);
      }
    } else {
      cp.set(path, null);
    }
  }

  /** Code + conversation rewind: restore files touched after this turn to their
   *  pre-turn state, then drop the later turns. Checkpoints are per-session
   *  (in-memory), so this works until the view is reloaded. */
  private async rewindCodeTo(c: Convo, turnEl: HTMLElement): Promise<void> {
    if (c.streaming) {
      new Notice("Stop the current turn before rewinding.");
      return;
    }
    const turns = Array.from(c.listEl.querySelectorAll(".mva-turn"));
    const idx = turns.indexOf(turnEl);
    if (idx < 0) return;

    // Undo THIS turn's edits and everything after — restore files to before this
    // turn ran. Iterate oldest→newest, first write per path wins (it holds the
    // state as of the rewind point).
    const undone = c.messages.slice(idx);
    const restored = new Set<string>();
    let changed = 0;
    let missingCheckpoints = false;
    for (const m of undone) {
      if (m.role !== "assistant") continue;
      if (!m.checkpoint) {
        if (m.segments.some((seg) => seg.t === "tool")) missingCheckpoints = true;
        continue;
      }
      for (const [path, before] of m.checkpoint) {
        if (restored.has(path)) continue;
        restored.add(path);
        try {
          const f = this.app.vault.getAbstractFileByPath(path);
          if (before === null) {
            if (f instanceof TFile) {
              await this.app.vault.delete(f);
              changed++;
            }
          } else if (f instanceof TFile) {
            await this.app.vault.modify(f, before);
            changed++;
          } else {
            // recreate a file that was deleted after the rewind point
            await this.app.vault.create(path, before);
            changed++;
          }
        } catch {
          /* skip files we can't restore */
        }
      }
    }

    // Then the conversation rewind — drop this turn and everything after.
    c.messages = c.messages.slice(0, idx);
    for (let i = turns.length - 1; i >= idx; i--) turns[i].remove();
    this.dropSession(c);
    c.sessionId = undefined;
    c.queue = [];
    this.renderQueue(c);
    c.updatedAt = Date.now();
    this.updateUsage(null);
    this.persist();
    const note = `Rewound. Restored ${changed} file${changed === 1 ? "" : "s"}; session reset.`;
    new Notice(missingCheckpoints ? `${note} (some edits had no snapshot — reload clears checkpoints.)` : note);
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
    this.renderTabs(); // keep the per-tab streaming dot in sync
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
    if (!text && this.pendingImages.length === 0) return;
    this.inputEl.value = "";
    this.autoGrow();
    const images = this.pendingImages.length ? this.pendingImages : undefined;
    this.pendingImages = [];
    this.renderImageStrip();
    const c = this.active;
    if (c.streaming) {
      c.queue.push({ text, images }); // queue while a turn is running
      this.renderQueue(c);
    } else {
      void this.runTurn(c, text, images);
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
      row.createSpan({
        cls: "mva-queued-text",
        text: q.text + (q.images?.length ? `  📎${q.images.length}` : ""),
      });
      const x = row.createSpan({ cls: "mva-chip-x", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      x.onclick = () => {
        c.queue.splice(i, 1);
        this.renderQueue(c);
      };
    });
    this.scrollConvo(c);
  }

  private async runTurn(c: Convo, text: string, images?: ImageAttachment[]): Promise<void> {
    const paths = c === this.active ? this.contextPaths() : [];
    const message = paths.length
      ? `Context notes:\n${paths.map((p) => `- ${p}`).join("\n")}\n\n${text}`
      : text;

    // Images are Claude-only; warn and drop for Codex.
    let imgs = images;
    if (imgs?.length && c.provider !== "claude") {
      new Notice("Image attachments are supported on Claude — sending text only.");
      imgs = undefined;
    }
    // Add any `![[image]]` embeds referenced in the text (Claude only).
    if (c.provider === "claude") {
      const embedded = await this.embeddedImages(text);
      if (embedded.length) imgs = [...(imgs ?? []), ...embedded];
    }

    this.addUserTurn(c, text, imgs);
    const ctx = this.addAssistantTurn(c, text);
    c.stopped = false;
    this.setStreaming(c, true);

    const adapter = ADAPTERS[c.provider];
    const s = this.plugin.settings;

    // File snapshots taken before this turn's writes, for "Rewind code + conversation".
    const checkpoint: Checkpoint = new Map();

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
          if (e.name === "TodoWrite") {
            this.renderTodos(ctx, e.input);
            break;
          }
          this.addToolCard(ctx, e.id, e.name, e.input);
          const fp = toolFilePath(e.name, e.input);
          if (fp) {
            const writeTools = /Write|Edit|MultiEdit|append_to_note|update_frontmatter|create_note|add_links/;
            const kind = writeTools.test(e.name) ? "write" : "read";
            if (kind === "read") ctx.sources.add(fp);
            else void this.snapshot(checkpoint, fp); // checkpoint before the write runs
            if (!ctx.touched.some((t) => t.path === fp)) ctx.touched.push({ path: fp, kind });
          }
          break;
        }
        case "tool-call-result":
          this.resolveToolCard(ctx, e.id, e.ok, e.output);
          break;
        case "permission-request": {
          const isRead = READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool);
          const fp = toolFilePath(e.tool, e.input);
          const isWrite =
            !!fp && /Write|Edit|MultiEdit|append_to_note|update_frontmatter|create_note|add_links|NotebookEdit/.test(e.tool);
          // Snapshot the target file (pre-edit) before letting a write proceed.
          const allow = (d: { behavior: "allow"; remember?: boolean }) => {
            if (isWrite && fp) void this.snapshot(checkpoint, fp).finally(() => e.resolve(d));
            else e.resolve(d);
          };
          if ((s.autoAllowRead && isRead) || c.allow.has(e.tool)) {
            allow({ behavior: "allow" });
          } else if (OBSIDIAN_MEMORY_TOOLS.has(e.tool) && !s.memoryWriteEnabled) {
            e.resolve({ behavior: "deny", message: "Memory writing is disabled in Exo settings." });
          } else {
            this.addPermissionCard(ctx, c, e.tool, e.input, (d) =>
              d.behavior === "allow" ? allow(d) : e.resolve(d)
            );
          }
          break;
        }
        case "usage":
          if (c === this.active) this.updateUsage(e.usage);
          break;
        case "compact": {
          const div = c.listEl.createDiv({ cls: "mva-compact-divider" });
          setIcon(div.createSpan({ cls: "mva-compact-icon" }), "scissors");
          div.createSpan({ text: "Context compacted" });
          this.scrollConvo(c);
          break;
        }
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
      await session.send(message, onEvent, imgs);
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
      if (ctx.segments.length) {
        c.messages.push({
          role: "assistant",
          segments: ctx.segments,
          ...(checkpoint.size ? { checkpoint } : {}),
        });
      }
      c.updatedAt = Date.now();
      this.setStreaming(c, false);
      this.persist();
      this.scrollConvo(c);
      // Drain the queue: run the next message in this conversation.
      if (c.queue.length) {
        const next = c.queue.shift()!;
        this.renderQueue(c);
        void this.runTurn(c, next.text, next.images);
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
