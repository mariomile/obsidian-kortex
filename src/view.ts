import {
  ItemView,
  WorkspaceLeaf,
  MarkdownRenderer,
  FileSystemAdapter,
  FuzzySuggestModal,
  TFile,
  TFolder,
  setIcon,
  setTooltip,
  Notice,
  Keymap,
} from "obsidian";
import { Autocomplete, type AcItem } from "./ui/autocomplete";
import type ExoPlugin from "./main";
import { resolveCli, describeError, isAbort } from "./cli";
import { ADAPTERS } from "./providers/registry";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ImageAttachment,
  ProviderId,
} from "./providers/types";
import { toolMeta, toolFilePath, toolWorkingLabel, renderToolDetail, READ_ONLY_TOOLS } from "./ui/tools";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS, OBSIDIAN_MEMORY_TOOLS } from "./obsidian/tools";
import { readBootContext } from "./obsidian/memory";
import { relatedNotes, basename as noteBasename } from "./obsidian/graph";
import { wikilinkify, type TouchedNote } from "./ui/graph-view";
import { NoteDiffModal } from "./ui/note-diff";
import { renderCapabilitiesPanel } from "./ui/capabilities";
import { PromptVarsModal, extractVars, fillVars } from "./ui/prompt-vars";

export const VIEW_TYPE = "exo-view";
/** Custom Obsidian icon id for the Exo brand mark (registered in main.ts). */
export const EXO_ICON = "exo-star";

const MAX_CONVOS = 30;
const MAX_PERSIST_OUTPUT = 2000;
const MAX_CHECKPOINT_FILE = 64_000; // don't persist a rewind snapshot larger than this (bloat guard)

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
export interface AskQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}
type Segment =
  | { t: "text"; md: string }
  | { t: "tool"; name: string; input: unknown; ok: boolean | null; output: string }
  | { t: "ask"; questions: AskQuestion[]; answers: Record<string, string> }
  | { t: "artifact"; path: string };
/** Per-turn file snapshot for code rewind: path → content before the turn (null = didn't exist). */
type Checkpoint = Map<string, string | null>;
type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; checkpoint?: Checkpoint };

/** On-disk form of a message: the checkpoint Map is stored as [path, content] entries. */
type PersistedMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; segments: Segment[]; checkpoint?: [string, string | null][] };

interface ConvoData {
  id: string;
  title: string;
  provider: ProviderId;
  model: string;
  sessionId?: string;
  updatedAt?: number;
  messages: PersistedMessage[];
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
  pendingAsk: (() => void) | null; // cancels an open ask card on stop
  queue: { text: string; images?: ImageAttachment[] }[];
  pendingEl: HTMLElement | null; // container for queued-message chips
  /** The in-flight assistant turn of THIS conversation (null when idle) — the
   *  target for its session's ask_user cards, so parallel conversations can't
   *  cross-render into each other's transcripts. */
  currentCtx: AssistantCtx | null;
}

interface AssistantCtx {
  el: HTMLElement;
  bodyEl: HTMLElement;
  cards: Map<string, ToolCard>;
  segById: Map<string, Segment>;
  segments: Segment[];
  curTextEl: HTMLElement | null;
  /** Chars of curRaw already rendered into stable (final) blocks. */
  stableLen: number;
  /** Live tail element re-rendered each tick (holds the not-yet-stable suffix). */
  tailEl: HTMLElement | null;
  /** The live streaming caret (at most one per turn), tracked so cleanup is O(1). */
  caretEl: HTMLElement | null;
  /** Incremental block-boundary scan state over curRaw (O(delta) per tick):
   *  chars already scanned (complete lines only) … */
  scanPos: number;
  /** … whether scanPos sits inside a ``` fence … */
  fenceOpen: boolean;
  /** … and the last safe (non-fenced blank-line) boundary found so far. */
  lastBoundary: number;
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
  /** Tool-use id → file path, for write tools (to reveal the note on result). */
  writeById: Map<string, string>;
  /** Notes already revealed this turn (dedupe). */
  revealed: Set<string>;
  /** Vault-relative paths that got a preview card this turn (dedupe, first write wins). */
  artifacts: Set<string>;
  /** Vault-relative paths that did NOT exist when first written this turn (newly created). */
  createdPaths: Set<string>;
  convo: Convo;
  /** Per-turn debounce timer, so parallel conversations don't fight over a shared one. */
  renderTimer: number | null;
  /** Live TodoWrite panel for this turn (re-rendered on each update). */
  todosEl: HTMLElement | null;
  /** Background Bash tasks this turn: tool-call id → card + badge + parsed shell id. */
  bgTasks: Map<string, { cardEl: HTMLElement; badgeEl: HTMLElement; shellId?: string }>;
  /** Task (subagent) cards this turn: Task tool-call id → nested activity section. */
  taskCards: Map<string, { container: HTMLElement; summaryEl: HTMLElement; rowsEl: HTMLElement; count: number }>;
  /** Subagent mini-rows this turn (live-only): tool-call id → status dot + parent. */
  nestedRows: Map<string, { dotEl: HTMLElement; parentId: string }>;
  /** Working-indicator row (Feature 1) — star + phase label + elapsed + esc hint.
   *  Always re-appended as the last child of bodyEl so it trails the transcript. */
  workingEl: HTMLElement | null;
  workingLabel: HTMLElement | null;
  workingElapsed: HTMLElement | null;
  /** System-notification dedupe keys fired this turn (Feature 3): "done" | "waiting" | "error". */
  notified: Set<string>;
}

/** Abort a turn if no event arrives for this long (avoids infinite loading). */
const IDLE_TIMEOUT = 120_000;

/** Advance the incremental block-boundary scan over the not-yet-scanned suffix
 * of `ctx.curRaw` and return the index just after the last blank-line boundary
 * that is not inside a ``` fence (0 if none). Only complete (newline-terminated)
 * lines are consumed — the trailing partial line waits for its newline — so each
 * streaming tick costs O(new chars), not O(total). Rendering the prefix up to
 * the returned boundary is layout-stable. */
function advanceBoundary(ctx: AssistantCtx): number {
  const raw = ctx.curRaw;
  let nl: number;
  while ((nl = raw.indexOf("\n", ctx.scanPos)) !== -1) {
    const t = raw.slice(ctx.scanPos, nl).trim();
    if (/^(```|~~~)/.test(t)) ctx.fenceOpen = !ctx.fenceOpen;
    ctx.scanPos = nl + 1;
    if (!ctx.fenceOpen && t === "") ctx.lastBoundary = ctx.scanPos;
  }
  return ctx.lastBoundary;
}

/** Merge one tool-touched file into a touched list: reads dedupe; a write
 * upgrades a read entry and bumps the per-note edit count. */
function mergeTouched(list: TouchedNote[], path: string, kind: "read" | "write"): void {
  const existing = list.find((t) => t.path === path);
  if (!existing) list.push({ path, kind, ...(kind === "write" ? { count: 1 } : {}) });
  else if (kind === "write") {
    existing.kind = "write"; // read-then-written → show as written
    existing.count = (existing.count ?? 0) + 1;
  }
}

/** One rule per line: `Tool` or `Tool(argPrefix)`. `#` comments allowed. A bare
 *  `Tool` matches any invocation. For `Bash` the prefix matches on a TOKEN
 *  boundary — `Bash(rm)` matches `rm -rf x` but NOT `rmdir` (a plain prefix
 *  would silently widen shell rules to unrelated commands). For every other
 *  tool the argument is a path/target, where prefix-of-path is the intent. */
function matchPermRule(rules: string, tool: string, argText: string): boolean {
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+(?:__[\w-]+)*)(?:\((.*?)\))?$/);
    if (!m || m[1] !== tool) continue;
    const prefix = (m[2] ?? "").replace(/\*+$/, "");
    if (!prefix) return true;
    if (tool === "Bash") {
      if (argText === prefix || argText.startsWith(prefix + " ")) return true;
    } else if (argText.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

let convoSeed = 0;

export class ChatView extends ItemView {
  private provider: ProviderId;
  private model: string;
  private usageEl: HTMLElement | null = null;

  /** Active conversation is streaming (drives the send/stop button). */
  private get streaming(): boolean {
    return this.active?.streaming ?? false;
  }
  private memoryPreamble = "";
  /** In-flight session spawns, so a pre-warm and a real send don't double-spawn
   *  (and leak) a CLI session for the same conversation. */
  private sessionInit = new WeakMap<Convo, { sig: string; promise: Promise<AgentSession> }>();
  /** Monotonic per-convo spawn counter: a spawn only installs its session if no
   *  newer spawn (or dropSession) superseded it while it was awaiting. */
  private spawnSeq = new WeakMap<Convo, number>();

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
  private lastPersistErrorNotice = 0;
  private pendingImages: ImageAttachment[] = [];
  private imagesEl!: HTMLElement;
  /** Whether the view auto-follows new content to the bottom. False once the
   *  user scrolls up, so streaming no longer yanks them back down. */
  private pinnedToBottom = true;
  /** Coalesces scroll writes into one rAF per frame. */
  private scrollRaf: number | null = null;
  /** Floating jump-to-bottom button (lazily created). */
  private jumpPill: HTMLElement | null = null;
  /** Whether we've already lazily asked for OS notification permission (once). */
  private notifyPermAsked = false;

  constructor(leaf: WorkspaceLeaf, private plugin: ExoPlugin) {
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
    return EXO_ICON;
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
    this.prewarm();
  }

  async onClose(): Promise<void> {
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    // this.active is always within this.convos, so the loop covers it.
    for (const c of this.convos) this.dropSession(c);
  }

  /** Focus the composer input — called when the view is opened via ribbon/command. */
  focusComposer(): void {
    window.setTimeout(() => this.inputEl?.focus(), 0);
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
      s.runHooks,
      s.systemPrompt,
      s.obsidianToolsEnabled,
      s.nativeFirst,
      s.memoryReadEnabled,
      s.memoryWriteEnabled,
      s.autoCompactEnabled,
      s.contextSavingMode,
      s.codexSandbox,
      s.codexApproval,
      c.id,
    ].join("|");
  }

  private ensureSession(c: Convo): Promise<AgentSession> {
    const sig = this.sessionSigOf(c);
    if (c.session && sig === c.sessionSig) return Promise.resolve(c.session);
    // Reuse an in-flight spawn ONLY if it was started for the same config
    // signature — a stale-sig spawn (settings changed mid-prewarm) must not be
    // handed to a send that expects the new config.
    const inflight = this.sessionInit.get(c);
    if (inflight && inflight.sig === sig) return inflight.promise;
    const promise = this.spawnSession(c, sig);
    this.sessionInit.set(c, { sig, promise });
    const cleanup = () => {
      if (this.sessionInit.get(c)?.promise === promise) this.sessionInit.delete(c);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  private async spawnSession(c: Convo, sig: string): Promise<AgentSession> {
    // Claim a spawn slot: any older in-flight spawn is superseded from now on.
    const seq = (this.spawnSeq.get(c) ?? 0) + 1;
    this.spawnSeq.set(c, seq);
    c.session?.dispose();
    const s = this.plugin.settings;
    const bin = c.provider === "claude" ? s.claudeBin : s.codexBin;
    const cli = await resolveCli(c.provider, bin);

    // Obsidian-native tools are Claude-only and require agentic (gated) mode.
    const useObsidian = s.obsidianToolsEnabled && s.toolsEnabled && c.provider === "claude";
    // The createSdkMcpServer instance binds to its first session's transport and
    // is NOT reusable across query() sessions — a cached instance means every
    // session after the first (new tabs, post-error respawns) boots without the
    // obsidian tools. Build a FRESH server per spawn; it's cheap (plain object +
    // zod schemas), and the settings it depends on are read at creation time.
    const obsidianServer = useObsidian
      ? createObsidianToolServer(this.app, !s.contextSavingMode, s.memoryWriteEnabled, (qs) =>
          // Per-session server + per-convo closure: ask_user always renders into
          // the conversation that owns this session, never a parallel one.
          this.askBridge(c, qs)
        )
      : undefined;

    let memoryPreamble: string | undefined;
    if (s.memoryReadEnabled && c.provider === "claude") {
      if (!this.memoryPreamble) this.memoryPreamble = await readBootContext(this.app);
      memoryPreamble = this.memoryPreamble || undefined;
    }

    const session = ADAPTERS[c.provider].createSession({
      cli,
      model: c.model,
      effort: s.effort,
      systemPrompt: s.systemPrompt || undefined,
      cwd: this.vaultPath(),
      permissionMode: s.permissionMode,
      toolsEnabled: s.toolsEnabled,
      fastStartup: s.fastStartup,
      runHooks: s.runHooks,
      resumeSessionId: c.sessionId,
      obsidianServer,
      nativeFirst: useObsidian && s.nativeFirst,
      memoryPreamble,
      autoCompact: s.autoCompactEnabled && c.provider === "claude",
      sandboxMode: s.codexSandbox,
      approvalPolicy: s.codexApproval,
    });
    // Superseded while awaiting (newer spawn or dropSession): don't install —
    // dispose the fresh session so it can't leak as an orphaned CLI process.
    if (this.spawnSeq.get(c) !== seq) {
      session.dispose();
      throw new Error("Session spawn superseded.");
    }
    c.session = session;
    c.sessionSig = sig;
    return session;
  }

  private dropSession(c: Convo): void {
    // Supersede any in-flight spawn so it can't install a session after the drop.
    this.spawnSeq.set(c, (this.spawnSeq.get(c) ?? 0) + 1);
    this.sessionInit.delete(c);
    c.session?.dispose();
    c.session = null;
    c.sessionSig = "";
  }

  /** Spin up the active conversation's CLI session in the background so the first
   *  message skips the cold start. No-op if disabled, already warm, streaming, or
   *  on Codex (spawn-per-turn model — nothing to warm). Errors are swallowed; a
   *  real send surfaces them through the normal UX. */
  private prewarm(): void {
    if (!this.plugin.settings.prewarmSession) return;
    const c = this.active;
    if (!c || c.provider !== "claude" || c.session || c.streaming) return;
    void this.ensureSession(c).catch(() => {});
  }

  /* ----------------------------- header ----------------------------- */

  /** Make a non-button element keyboard- and screen-reader-operable: role=button,
   *  focusable, and Enter/Space fire the same handler as a click. Use for the div/
   *  span controls that can't easily become <button> without losing their layout. */
  private clickable(el: HTMLElement, handler: (e: Event) => void): void {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler(e);
      }
    });
  }

  private buildHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: "mva-header" });
    this.brandDot = header.createSpan({ cls: "mva-brand-icon" });
    setIcon(this.brandDot, EXO_ICON);
    header.createSpan({ cls: "mva-brand-name", text: "Exo" });
    header.createDiv({ cls: "mva-spacer" }).style.flex = "1";

    const caps = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "Capabilities" } });
    setIcon(caps, "blocks");
    setTooltip(caps, "Capabilities");
    caps.onclick = () => this.toggleCapabilities();

    const histBtn = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "History" } });
    setIcon(histBtn, "history");
    setTooltip(histBtn, "History");
    histBtn.onclick = () => this.toggleGallery();

    const newChat = header.createEl("button", { cls: "mva-icon-btn", attr: { "aria-label": "New chat" } });
    setIcon(newChat, "plus");
    setTooltip(newChat, "New chat");
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
    this.refreshPermChipFn();
    // Provider changed (e.g. back to Claude) — warm the new session.
    this.prewarm();
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
    // Provider identity tints the brand star. All interactive accents follow
    // the theme (--mva-brand defaults to --interactive-accent in CSS).
    this.brandDot.style.color = a.brandColor;
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
    // Only build transcript DOM for conversations that will actually be shown
    // (open tabs + the active one). Everything else renders lazily on first
    // open (switchTo) — with dozens of stored conversations this is the bulk
    // of the view's startup cost.
    const wantDom = new Set([...(this.plugin.settings.openTabIds ?? []), this.plugin.settings.activeTabId]);
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
        messages: d.messages.map((m) => this.reviveMessage(m)),
        session: null,
        sessionSig: "",
        streaming: false,
        stopped: false,
        pendingPerm: null,
        pendingAsk: null,
        queue: [],
        pendingEl: null,
        currentCtx: null,
      };
      if (wantDom.has(c.id)) this.renderConvoDom(c);
      this.wireScroll(c);
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

    // Safety: if the active fell back to a convo outside the saved tab set
    // (stale activeTabId), its DOM wasn't pre-built above — build it now.
    if (this.active.messages.length && this.active.listEl.childElementCount === 0) {
      this.renderConvoDom(this.active);
    }
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
              ...(m.checkpoint && m.checkpoint.size
                ? {
                    checkpoint: [...m.checkpoint.entries()].filter(
                      ([, v]) => v === null || v.length <= MAX_CHECKPOINT_FILE
                    ),
                  }
                : {}),
            }
          : m
      ),
    }));
  }

  /** Convert a persisted message to its runtime form (checkpoint entries → Map). */
  private reviveMessage(m: PersistedMessage): Message {
    if (m.role === "user") return m;
    return {
      role: "assistant",
      segments: m.segments,
      ...(Array.isArray(m.checkpoint) ? { checkpoint: new Map(m.checkpoint) } : {}),
    };
  }

  private persist(): void {
    void this.plugin.saveConversations(this.serialize()).then((ok) => {
      if (ok) return;
      // Throttle so a persistent disk problem doesn't spam a Notice every turn.
      const now = Date.now();
      if (now - this.lastPersistErrorNotice > 30_000) {
        this.lastPersistErrorNotice = now;
        new Notice("Exo couldn't save conversation history — check disk space and vault permissions.");
      }
    });
  }

  /* ------------------------- conversations -------------------------- */

  private makeConvo(): Convo {
    const c: Convo = {
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
      pendingAsk: null,
      queue: [],
      pendingEl: null,
      currentCtx: null,
    };
    this.wireScroll(c);
    return c;
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
    // A fresh tab should always start pinned so you see the latest content.
    this.pinnedToBottom = true;
    this.updateJumpPill();
    // Lazily build the transcript DOM on first open (restore() skips convos
    // that weren't in the saved tab set).
    if (c.messages.length && c.listEl.childElementCount === 0) this.renderConvoDom(c);
    this.listWrap.empty();
    this.listWrap.appendChild(c.listEl);
    if (c.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.updateUsage(null);
    this.renderTabs();
    this.persistTabs();
    this.scrollConvo(c);
    this.prewarm();
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
      this.clickable(tab, () => this.switchTo(c));
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
    setTooltip(this.sendBtn, on ? "Stop" : "Send");
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

    const sorted = [...this.convos]
      .filter((c) => c.messages.length > 0 || c === this.active)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

    if (sorted.length === 0) {
      wrap.createDiv({ cls: "mva-gallery" }).createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
      return;
    }

    const searchWrap = wrap.createDiv({ cls: "mva-gallery-search-wrap" });
    setIcon(searchWrap.createSpan({ cls: "mva-gallery-search-ico" }), "search");
    const search = searchWrap.createEl("input", {
      cls: "mva-gallery-search",
      attr: { type: "text", placeholder: "Search conversations…" },
    });
    const grid = wrap.createDiv({ cls: "mva-gallery" });
    const renderGrid = (q: string) => {
      grid.empty();
      const ql = q.toLowerCase().trim();
      const matches = ql ? sorted.filter((c) => this.convoMatches(c, ql)) : sorted;
      if (matches.length === 0) {
        grid.createDiv({ cls: "mva-empty-sub", text: "No matching conversations." });
        return;
      }
      for (const c of matches) this.renderCard(grid, c);
    };
    search.addEventListener("input", () => renderGrid(search.value));
    renderGrid("");
  }

  private renderCard(grid: HTMLElement, c: Convo): void {
    const card = grid.createDiv({ cls: "mva-card" });
    if (c === this.active) card.addClass("is-active");
    this.addCardDelete(card, grid, c);
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

    this.clickable(card, () => {
      this.hideGallery();
      this.switchTo(c);
    });
  }

  /** Trash button on a gallery card: two-step confirm (arm → delete), reusing the
   *  note-revert arming pattern. Never bubbles to the card's open handler. */
  private addCardDelete(card: HTMLElement, grid: HTMLElement, c: Convo): void {
    const del = card.createSpan({ cls: "mva-gal-del", attr: { "aria-label": "Delete conversation" } });
    setIcon(del, "trash-2");
    let armed = false;
    let disarmTimer: number | null = null;
    const outside = (ev: MouseEvent) => {
      if (ev.target !== del && !del.contains(ev.target as Node)) disarm();
    };
    const disarm = () => {
      armed = false;
      del.removeClass("is-armed");
      del.setAttr("aria-label", "Delete conversation");
      if (disarmTimer) {
        window.clearTimeout(disarmTimer);
        disarmTimer = null;
      }
      document.removeEventListener("click", outside, true);
    };
    del.onclick = (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        del.addClass("is-armed");
        del.setAttr("aria-label", "Click again to delete");
        disarmTimer = window.setTimeout(disarm, 3000);
        document.addEventListener("click", outside, true);
        return;
      }
      disarm();
      this.deleteConvo(c, card, grid);
    };
  }

  /** Permanently drop a conversation (from the gallery). If it's the active tab,
   *  switch to a neighbor — or a fresh convo when none remain — exactly like the
   *  close-tab flow, but keep the gallery open and just remove its card. */
  private deleteConvo(c: Convo, card: HTMLElement, grid: HTMLElement): void {
    this.dropSession(c);
    const tabIdx = this.openTabs.indexOf(c.id);
    if (tabIdx !== -1) this.openTabs.splice(tabIdx, 1);
    const convoIdx = this.convos.indexOf(c);
    if (convoIdx !== -1) this.convos.splice(convoIdx, 1);

    if (c === this.active) {
      const nextId =
        this.openTabs[tabIdx] ?? this.openTabs[tabIdx - 1] ?? this.openTabs[this.openTabs.length - 1];
      let next = nextId ? this.convos.find((x) => x.id === nextId) : undefined;
      if (!next) next = this.convos[0];
      if (!next) {
        next = this.makeConvo();
        this.convos.push(next);
        this.openTabs.push(next.id);
      }
      c.listEl.remove();
      this.setActiveSilently(next);
    } else {
      this.renderTabs();
      this.persistTabs();
    }

    card.remove();
    if (!grid.querySelector(".mva-card")) {
      grid.createDiv({ cls: "mva-empty-sub", text: "No conversations yet." });
    }
    this.persist();
  }

  /** Point `active` at another conversation without leaving the gallery overlay:
   *  its transcript is prepared (rendered, hidden behind the gallery) so a later
   *  hideGallery/switchTo reveals it correctly. */
  private setActiveSilently(next: Convo): void {
    this.active = next;
    this.provider = next.provider;
    this.model = next.model;
    if (!this.openTabs.includes(next.id)) this.openTabs.push(next.id);
    if (next.messages.length && next.listEl.childElementCount === 0) this.renderConvoDom(next);
    next.listEl.hide(); // gallery is on top; reveal happens on hideGallery/switchTo
    this.listWrap.appendChild(next.listEl);
    if (next.listEl.childElementCount === 0) this.renderEmptyState();
    this.refreshProviderUI();
    this.syncSendButton();
    this.updateUsage(null);
    this.renderTabs();
    this.persistTabs();
  }

  private convoPreview(c: Convo): string {
    let s = "";
    for (const m of c.messages) {
      const part =
        m.role === "user"
          ? m.text
          : m.segments
              .map((seg) =>
                seg.t === "text"
                  ? seg.md
                  : seg.t === "ask"
                    ? "↳ asked: " + seg.questions.map((q) => q.header).join(", ")
                    : seg.t === "artifact"
                      ? "🖼 " + noteBasename(seg.path)
                      : `↳ ${toolMeta(seg.name, seg.input).label}`
              )
              .join(" ");
      s += part.replace(/[#*`>_~]/g, "").replace(/\s+/g, " ").trim() + "  ";
      if (s.length > 320) break;
    }
    return s.trim();
  }

  /** True if the query matches a conversation's title or any of its message text. */
  private convoMatches(c: Convo, ql: string): boolean {
    if (c.title.toLowerCase().includes(ql)) return true;
    for (const m of c.messages) {
      const text =
        m.role === "user"
          ? m.text
          : m.segments.map((s) => (s.t === "text" ? s.md : "")).join(" ");
      if (text.toLowerCase().includes(ql)) return true;
    }
    return false;
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
      if (e.key === "Escape" && this.streaming) {
        e.preventDefault();
        this.stop();
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

  private slashCache: { commands: string[]; skills: string[]; agents: string[]; ts: number } | null = null;
  private static readonly SLASH_TTL = 30_000;

  private async loadSlash(): Promise<{ commands: string[]; skills: string[]; agents: string[] }> {
    if (this.slashCache && Date.now() - this.slashCache.ts < ChatView.SLASH_TTL) return this.slashCache;
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
    this.slashCache = { commands, skills, agents, ts: Date.now() };
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
        const isWorkflow = p.prompt.includes(" >>> ");
        out.push({
          label: p.name,
          detail: isWorkflow ? "workflow" : "prompt",
          icon: isWorkflow ? "list-ordered" : "message-square",
          insert: "",
          onSelect: () => this.usePrompt(p.prompt),
        });
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

  /** Tool names that mutate a note — used to classify touched notes as read vs write. */
  private static readonly WRITE_TOOLS = /Write|Edit|MultiEdit|NotebookEdit|append_to_note|update_frontmatter|create_note|add_links|edit_note|insert_at_cursor|rename_note/;

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
    // Provider-aware: Claude has canUseTool (permission mode gates tool calls);
    // Codex has no canUseTool — its sandbox setting is the actual gate, so in
    // Codex mode this chip shows and controls codexSandbox instead.
    this.refreshPermChipFn = this.buildSelectChip(tb, {
      ariaLabel: "Permission mode",
      getLabel: () =>
        this.provider === "codex"
          ? `Sandbox: ${ChatView.codexSandboxLabel(s.codexSandbox)}`
          : `Perm: ${ChatView.permLabel(s.permissionMode)}`,
      getOptions: () =>
        this.provider === "codex"
          ? ChatView.CODEX_SANDBOX_OPTS.map(([v, l]) => ({ value: v, label: l, risk: ChatView.codexSandboxRisk(v) }))
          : ChatView.PERM_OPTS.map(([v, l]) => ({ value: v, label: l, risk: ChatView.permRisk(v) })),
      getCurrent: () => (this.provider === "codex" ? s.codexSandbox : s.permissionMode),
      chipRisk: () =>
        this.provider === "codex" ? ChatView.codexSandboxRisk(s.codexSandbox) : ChatView.permRisk(s.permissionMode),
      onSelect: (v) => {
        if (this.provider === "codex") {
          s.codexSandbox = v;
          void this.plugin.saveSettings();
        } else {
          s.permissionMode = v as typeof s.permissionMode;
          void this.plugin.saveSettings();
          this.active.session?.setPermissionMode?.(s.permissionMode);
        }
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
    setTooltip(this.sendBtn, "Send");
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
    this.clickable(chip, (e) => {
      e.stopPropagation();
      if (open) return close();
      buildPop(); // rebuild fresh — option lists can change (e.g. model list per provider)
      open = true;
      pop.show();
      document.addEventListener("click", onDoc, true);
    });
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

  /** Codex sandbox options (Codex has no canUseTool — its sandbox is the gate). */
  private static readonly CODEX_SANDBOX_OPTS: [string, string][] = [
    ["read-only", "Read-only"],
    ["workspace-write", "Workspace write"],
    ["danger-full-access", "Full access"],
  ];
  private static codexSandboxLabel(mode: string): string {
    return ChatView.CODEX_SANDBOX_OPTS.find(([v]) => v === mode)?.[1] ?? mode;
  }
  private static codexSandboxRisk(mode: string): RiskLevel {
    if (mode === "danger-full-access") return "is-danger";
    if (mode === "workspace-write") return "is-caution";
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
    // Every context note is a uniform card in a horizontal row (Craft-style):
    // the active note first ("Current Document"), then manual attachments.
    const active = this.excludeActiveNote ? null : this.activeNotePath();
    const cards = this.contextEl.createDiv({ cls: "mva-doc-cards" });
    if (active) this.renderContextCard(cards, active, true);
    for (const p of this.manualAttached) {
      if (p !== active) this.renderContextCard(cards, p, false);
    }
    // Trailing "add note" card.
    const add = cards.createDiv({ cls: "mva-doc-card mva-doc-add", attr: { "aria-label": "Attach a note" } });
    setIcon(add.createSpan({ cls: "mva-doc-add-ico" }), "plus");
    add.createSpan({ text: "Add note" });
    this.clickable(add, () => this.pickNote());
  }

  /** A uniform context card: text thumbnail + title + kind ("Current Document" / "Document"). */
  private renderContextCard(parent: HTMLElement, path: string, isActive: boolean): void {
    const card = parent.createDiv({ cls: "mva-doc-card" });
    const thumb = card.createDiv({ cls: "mva-doc-thumb" });
    void this.fillThumb(thumb, path);
    const body = card.createDiv({ cls: "mva-doc-body" });
    body.createDiv({ cls: "mva-doc-title", text: noteBasename(path), attr: { title: path } });
    body.createDiv({ cls: "mva-doc-kind", text: isActive ? "Current Document" : "Document" });
    const x = card.createSpan({ cls: "mva-doc-x", attr: { "aria-label": "Remove from context" } });
    setIcon(x, "x");
    x.onclick = (e) => {
      e.stopPropagation();
      if (isActive) this.excludeActiveNote = true;
      else this.manualAttached = this.manualAttached.filter((p) => p !== path);
      this.refreshContext();
    };
    this.clickable(card, () => this.openNote(path));
  }

  private static readonly IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

  /**
   * Fill a card thumbnail: image files get a real image preview, markdown gets a
   * tiny text preview ("document" look), everything else gets a file-type icon.
   */
  private async fillThumb(el: HTMLElement, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      el.addClass("is-icon");
      setIcon(el, "file");
      return;
    }
    if (ChatView.IMAGE_EXT.test(f.extension)) {
      el.addClass("is-image");
      const img = el.createEl("img");
      img.src = this.app.vault.getResourcePath(f);
      img.onerror = () => {
        el.empty();
        el.removeClass("is-image");
        el.addClass("is-icon");
        setIcon(el, "image");
      };
      return;
    }
    if (f.extension !== "md") {
      el.addClass("is-icon");
      setIcon(el, "file");
      return;
    }
    try {
      const txt = (await this.app.vault.cachedRead(f))
        .replace(/^---\n[\s\S]*?\n---\n?/, "") // drop frontmatter
        .replace(/!?\[\[[^\]]*\]\]/g, " ") // drop embeds / wikilinks
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // md links → their text
        .replace(/[#>*_`~]/g, "")
        .trim();
      if (txt) el.setText(txt.slice(0, 260));
      else {
        el.addClass("is-icon");
        setIcon(el, "file-text");
      }
    } catch {
      el.addClass("is-icon");
      setIcon(el, "file-text");
    }
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

  /** Use a custom prompt. A single prompt is inserted into the composer; a
   *  workflow (steps separated by " >>> ") is queued and run in sequence.
   *  {{variables}} across all steps are collected once, then applied to each. */
  private usePrompt(promptText: string): void {
    const steps = promptText.split(/\s+>>>\s+/).map((s) => s.trim()).filter(Boolean);
    const vars = extractVars(promptText);
    const run = (values: Record<string, string>) => {
      if (steps.length > 1) {
        this.runWorkflow(this.active, steps.map((s) => fillVars(s, values)));
      } else {
        this.insertAtComposer(fillVars(promptText, values));
      }
    };
    if (vars.length === 0) {
      run({});
      return;
    }
    new PromptVarsModal(this.app, vars, run).open();
  }

  /** Run a multi-step workflow by enqueuing its steps; the turn-drain loop runs
   *  them in order. Stop (which clears the queue) aborts the remaining steps. */
  private runWorkflow(c: Convo, steps: string[]): void {
    if (steps.length === 0) return;
    const [first, ...rest] = steps;
    for (const s of rest) c.queue.push({ text: s });
    if (c.streaming) {
      // Busy: queue the first step too; it runs when the current turn drains.
      c.queue.unshift({ text: first });
      this.renderQueue(c);
    } else {
      this.renderQueue(c);
      void this.runTurn(c, first);
    }
  }

  /** Insert text at the composer's caret (replacing any selection), then focus. */
  private insertAtComposer(text: string): void {
    const el = this.inputEl;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const caret = start + text.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    this.autoGrow();
  }

  /* --------------------------- rendering ---------------------------- */

  private static readonly STARTERS: [string, string, string][] = [
    ["file-text", "Summarize this note", "Summarize the current note in 5 concise bullets."],
    ["network", "Find related notes", "Find notes in my vault related to the current note and explain how they connect."],
    ["list-checks", "Extract action items", "Extract every action item and open question from the current note as a checklist."],
    ["pen-line", "Draft from outline", "Expand the outline in the current note into full prose in my voice."],
    ["sparkles", "Improve clarity", "Improve the clarity and flow of the current note without changing its meaning."],
    ["search", "Find gaps", "What's missing, unclear, or unsupported in the current note? List concrete gaps."],
  ];

  private renderEmptyState(): void {
    const empty = this.listEl.createDiv({ cls: "mva-empty" });
    empty.createDiv({ cls: "mva-empty-title", text: "What are we working on?" });
    this.renderPromptList(
      empty,
      "Suggestions",
      ChatView.STARTERS.map(([icon, label, prompt]) => ({ icon, label, prompt }))
    );
    this.renderPromptList(
      empty,
      "Your prompts",
      this.plugin.settings.customPrompts.map((p) => ({ icon: "message-square", label: p.name, prompt: p.prompt }))
    );
    this.renderSurfacing(empty);
  }

  /** A labelled, tappable prompt list (Suggestions / Your prompts) with "Show N more". */
  private renderPromptList(
    parent: HTMLElement,
    label: string,
    items: { icon: string; label: string; prompt: string }[],
    limit = 3
  ): void {
    if (!items.length) return;
    const sec = parent.createDiv({ cls: "mva-es-section" });
    sec.createDiv({ cls: "mva-es-label", text: label });
    const list = sec.createDiv({ cls: "mva-starters" });
    const render = (n: number) => {
      list.empty();
      for (const it of items.slice(0, n)) {
        const row = list.createDiv({ cls: "mva-starter" });
        setIcon(row.createSpan({ cls: "mva-starter-icon" }), it.icon);
        row.createSpan({ text: it.label });
        this.clickable(row, () => this.usePrompt(it.prompt));
      }
      if (n < items.length) {
        const more = list.createDiv({ cls: "mva-starter mva-es-more" });
        setIcon(more.createSpan({ cls: "mva-starter-icon" }), "chevron-down");
        more.createSpan({ text: `Show ${items.length - n} more` });
        more.onclick = () => render(items.length);
      }
    };
    render(Math.min(limit, items.length));
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
      this.clickable(chip, () => {
        if (!this.manualAttached.includes(p)) this.manualAttached.push(p);
        this.refreshContext();
        this.inputEl.focus();
      });
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
        const touched: TouchedNote[] = [];
        for (const s of m.segments) {
          if (s.t === "text") {
            void MarkdownRenderer.render(this.app, s.md, body.createDiv({ cls: "mva-bubble markdown-rendered" }), "", this);
            full += s.md;
          } else if (s.t === "ask") {
            const card = body.createDiv({ cls: "mva-ask" });
            this.renderAskSummary(card, s.questions, s.answers);
          } else if (s.t === "artifact") {
            this.buildArtifactCard(body, s.path);
          } else {
            const refs = this.createToolCard(body, s.name, s.input);
            this.finishToolCard(refs, s.ok !== false, s.output);
            const fp = toolFilePath(s.name, s.input);
            if (fp) mergeTouched(touched, fp, ChatView.WRITE_TOOLS.test(s.name) ? "write" : "read");
          }
        }
        this.attachTouched(el, touched, m.checkpoint);
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
      stableLen: 0,
      tailEl: null,
      caretEl: null,
      scanPos: 0,
      fenceOpen: false,
      lastBoundary: 0,
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
      writeById: new Map(),
      revealed: new Set(),
      artifacts: new Set(),
      createdPaths: new Set(),
      convo: c,
      renderTimer: null,
      todosEl: null,
      bgTasks: new Map(),
      taskCards: new Map(),
      nestedRows: new Map(),
      workingEl: null,
      workingLabel: null,
      workingElapsed: null,
      notified: new Set(),
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
      this.clickable(head, () => block.toggleClass("is-collapsed", !block.hasClass("is-collapsed")));
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

  /* ------------------------- working indicator ---------------------- */

  /** Create (once) the Claude-Code-style "working" row and move it to be the LAST
   *  child of bodyEl so it always trails the transcript, then show it. */
  private ensureWorking(ctx: AssistantCtx): void {
    let el = ctx.workingEl;
    if (!el) {
      el = createDiv({ cls: "mva-working" });
      setIcon(el.createSpan({ cls: "mva-working-star" }), EXO_ICON);
      ctx.workingLabel = el.createSpan({ cls: "mva-working-label", text: "Thinking…" });
      ctx.workingElapsed = el.createSpan({ cls: "mva-working-elapsed" });
      el.createSpan({ cls: "mva-working-hint", text: "esc to stop" });
      ctx.workingEl = el;
    }
    ctx.bodyEl.appendChild(el); // re-append: always the last element
    el.show();
  }

  /** Hide the working row (streaming text / an open interactive card takes over). */
  private hideWorking(ctx: AssistantCtx): void {
    ctx.workingEl?.hide();
  }

  /** Set the working row's phase label (no-op if the row was never created). */
  private setWorkingLabel(ctx: AssistantCtx, text: string): void {
    ctx.workingLabel?.setText(text);
  }

  /** Remove the working row entirely (turn end / error). */
  private removeWorking(ctx: AssistantCtx): void {
    ctx.workingEl?.remove();
    ctx.workingEl = null;
    ctx.workingLabel = null;
    ctx.workingElapsed = null;
  }

  /** Human elapsed: `37s` under a minute, `1m 12s` past it. */
  private fmtDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  /* ------------------------ system notifications -------------------- */

  /** OS notification while Obsidian is backgrounded (Feature 3). No-op if the
   *  setting is off or the window is focused. Lazily requests permission once. */
  private notify(title: string, body: string): void {
    if (!this.plugin.settings.systemNotifications) return;
    if (document.hasFocus()) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") return;
    if (Notification.permission === "default") {
      if (!this.notifyPermAsked) {
        this.notifyPermAsked = true;
        void Notification.requestPermission();
      }
      return; // permission resolves async — the next trigger fires
    }
    try {
      const n = new Notification(title, { body, silent: false });
      n.onclick = () => {
        window.focus();
        this.app.workspace.revealLeaf(this.leaf);
      };
    } catch {
      /* ignore — notifications unavailable */
    }
  }

  /** Fire a notification at most once per turn per type (`done`/`waiting`/`error`). */
  private notifyOnce(ctx: AssistantCtx, type: string, title: string, body: string): void {
    if (ctx.notified.has(type)) return;
    ctx.notified.add(type);
    this.notify(title, body);
  }

  private appendText(ctx: AssistantCtx, text: string): void {
    this.dropThinking(ctx);
    if (!ctx.curTextEl) {
      ctx.curTextEl = ctx.bodyEl.createDiv({ cls: "mva-bubble markdown-rendered" });
      ctx.curRaw = "";
      ctx.stableLen = 0;
      ctx.tailEl = null;
      ctx.scanPos = 0;
      ctx.fenceOpen = false;
      ctx.lastBoundary = 0;
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
    this.resetTextStream(ctx);
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
    const raw = ctx.curRaw || "";

    if (!streaming) {
      // Final render: one full, clean re-render of the whole reply (with
      // wikilinkify), matching the pre-incremental semantics exactly.
      ctx.tailEl = null;
      ctx.stableLen = 0;
      ctx.scanPos = 0;
      ctx.fenceOpen = false;
      ctx.lastBoundary = 0;
      el.empty();
      let md = raw;
      if (this.plugin.settings.featureWikilinkify) {
        md = wikilinkify(md, [...ctx.sources, ...ctx.touched.map((t) => t.path)]);
      }
      void MarkdownRenderer.render(this.app, md, el, "", this).then(() => {
        this.clearCaret(ctx);
      });
      return;
    }

    // Streaming tick: promote any newly-completed blocks to a stable, render-once
    // child, then re-render only the live tail (O(tail) per tick).
    const b = advanceBoundary(ctx);
    if (b > ctx.stableLen) {
      const block = ctx.curTextEl.createDiv({ cls: "mva-md-block markdown-rendered" });
      // Insert the stable block before the tail so ordering stays correct.
      if (ctx.tailEl) ctx.curTextEl.insertBefore(block, ctx.tailEl);
      void MarkdownRenderer.render(this.app, raw.slice(ctx.stableLen, b), block, "", this);
      ctx.stableLen = b;
    }
    if (!ctx.tailEl) ctx.tailEl = ctx.curTextEl.createDiv({ cls: "mva-md-tail markdown-rendered" });
    const tail = ctx.tailEl;
    tail.empty();
    void MarkdownRenderer.render(this.app, raw.slice(ctx.stableLen), tail, "", this).then(() => {
      // Keep at most one caret — on the tail that's currently streaming. Skip if
      // the segment was interrupted while this render was in flight (tailEl was
      // reset), so an in-flight tick can't resurrect an orphaned caret.
      if (ctx.tailEl !== tail || !tail.isConnected) return;
      this.clearCaret(ctx);
      ctx.caretEl = tail.createSpan({ cls: "mva-caret" });
    });
  }

  /** Remove the turn's tracked streaming caret (O(1) — no DOM query). */
  private clearCaret(ctx: AssistantCtx): void {
    ctx.caretEl?.remove();
    ctx.caretEl = null;
  }

  /** End the current text segment: null the stream targets, reset the incremental
   *  renderer state, and clear the caret left on the abandoned tail. Call at every
   *  site that interrupts a text segment (todos, tool card, permission, ask, error). */
  private resetTextStream(ctx: AssistantCtx): void {
    ctx.curTextEl = null;
    ctx.stableLen = 0;
    ctx.tailEl = null;
    ctx.scanPos = 0;
    ctx.fenceOpen = false;
    ctx.lastBoundary = 0;
    ctx.curTextSeg = null;
    this.clearCaret(ctx);
  }

  private scheduleRender(ctx: AssistantCtx): void {
    if (ctx.renderTimer !== null) return;
    // Per-tick work is now O(tail) (stable blocks render once), so length matters
    // far less — keep only a mild ladder for very chatty streams. The turn-end
    // flushRender always does the final full clean re-render.
    const len = ctx.curRaw.length;
    const delay = len > 8000 ? 150 : len > 3000 ? 100 : 60;
    ctx.renderTimer = window.setTimeout(() => {
      ctx.renderTimer = null;
      this.renderText(ctx, true);
      this.scrollConvo(ctx.convo);
    }, delay);
  }

  private flushRender(ctx: AssistantCtx): void {
    if (ctx.renderTimer !== null) {
      window.clearTimeout(ctx.renderTimer);
      ctx.renderTimer = null;
    }
    this.renderText(ctx, false);
    this.clearCaret(ctx);
    // Final-cleanup fallback: the tracked ref covers every live path, but the
    // turn is over — sweep the transcript so no caret can survive a desync.
    ctx.convo.listEl.querySelectorAll(".mva-caret").forEach((el) => el.remove());
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
   *  pre-turn state, then drop the later turns. Checkpoints are persisted with
   *  the conversation (size-capped per file), so rewind survives reloads; only
   *  oversized snapshots are dropped at persist time. */
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
    new Notice(missingCheckpoints ? `${note} (some edits had no snapshot — e.g. oversized files are not checkpointed.)` : note);
  }

  /**
   * Footer listing the notes a turn touched, split into what it *changed*
   * (emphasized, with ×N edit count + diff/revert actions) and what it *read*
   * (context). `checkpoint` (live or restored from persistence) enables per-note diff/revert.
   */
  private attachTouched(turnEl: HTMLElement, touched: TouchedNote[], checkpoint?: Checkpoint): void {
    if (touched.length === 0) return;
    const bar = turnEl.createDiv({ cls: "mva-sources" });
    const group = (label: string, kind: "read" | "write", icon: string) => {
      const items = touched.filter((t) => t.kind === kind);
      if (!items.length) return;
      const g = bar.createDiv({ cls: "mva-src-group" });
      g.createSpan({ cls: "mva-src-label", text: label });
      for (const t of items) {
        const chip = g.createSpan({ cls: `mva-src-chip is-${kind}` });
        setIcon(chip.createSpan({ cls: "mva-src-ico" }), icon);
        chip.createSpan({ cls: "mva-src-name", text: noteBasename(t.path) });
        if (kind === "write" && (t.count ?? 0) > 1) {
          chip.createSpan({ cls: "mva-src-count", text: `×${t.count}` });
        }
        chip.onclick = () => this.openNote(t.path);
        // Inline diff + revert — only when we hold this turn's pre-write snapshot.
        const rel = this.relPath(t.path);
        if (kind === "write" && checkpoint?.has(rel)) {
          this.addTouchedActions(chip, t.path, checkpoint.get(rel) ?? null);
        }
        if (kind === "read") {
          this.addReadActions(chip, t.path);
        }
      }
    };
    group("Edited", "write", "file-pen"); // changes first — the actionable output
    group("Read", "read", "file-text");
  }

  /** Hover actions on an edited-note chip: view diff, and a two-step revert. */
  private addTouchedActions(chip: HTMLElement, path: string, before: string | null): void {
    const acts = chip.createSpan({ cls: "mva-src-acts" });
    const diff = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "View diff" } });
    setIcon(diff, "file-diff");
    diff.onclick = (e) => {
      e.stopPropagation();
      void this.showNoteDiff(path, before);
    };

    const revert = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "Revert this note" } });
    setIcon(revert, "undo-2");
    let armed = false;
    let disarm: number | null = null;
    revert.onclick = (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        revert.addClass("is-armed");
        revert.setAttr("aria-label", "Click again to revert");
        disarm = window.setTimeout(() => {
          armed = false;
          revert.removeClass("is-armed");
          revert.setAttr("aria-label", "Revert this note");
        }, 3000);
        return;
      }
      if (disarm) window.clearTimeout(disarm);
      void this.revertNote(path, before, chip);
    };
  }

  /** Hover action on a read-note chip: attach it to the composer context. */
  private addReadActions(chip: HTMLElement, path: string): void {
    const acts = chip.createSpan({ cls: "mva-src-acts" });
    const attach = acts.createSpan({ cls: "mva-src-act", attr: { "aria-label": "Attach to context" } });
    setIcon(attach, "plus");
    attach.onclick = (e) => {
      e.stopPropagation();
      const rel = this.relPath(path);
      if (!this.manualAttached.includes(rel)) this.manualAttached.push(rel);
      this.refreshContext();
      new Notice(`Attached ${noteBasename(path)} to context.`);
    };
  }

  /** Open a read-only diff of the note (pre-turn snapshot vs current content). */
  private async showNoteDiff(path: string, before: string | null): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(this.relPath(path));
    let after = "";
    if (f instanceof TFile) {
      try {
        after = await this.app.vault.read(f);
      } catch {
        /* unreadable — show as empty */
      }
    }
    new NoteDiffModal(this.app, noteBasename(path), before, after, () => this.openNote(path)).open();
  }

  /** Restore a single note to its pre-turn snapshot (null = delete it). */
  private async revertNote(path: string, before: string | null, chip: HTMLElement): Promise<void> {
    const rel = this.relPath(path);
    const f = this.app.vault.getAbstractFileByPath(rel);
    try {
      if (before === null) {
        if (f instanceof TFile) await this.app.vault.delete(f);
      } else if (f instanceof TFile) {
        await this.app.vault.modify(f, before);
      } else {
        await this.app.vault.create(rel, before);
      }
      chip.addClass("is-reverted");
      new Notice(`Reverted ${noteBasename(path)} to before this turn.`);
    } catch {
      new Notice(`Couldn't revert ${noteBasename(path)}.`);
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

  /** Open a note the agent just edited in the main area — reuse its tab if it's
   *  already open, else a new tab (non-destructive; never the sidebar). Verified:
   *  openLinkText targets the main area even when Exo is the focused sidebar leaf. */
  private revealNote(path: string): void {
    const rel = this.relPath(path);
    const file = this.app.vault.getAbstractFileByPath(rel);
    if (!(file instanceof TFile)) return;
    const open = this.app.workspace
      .getLeavesOfType("markdown")
      .find((l) => (l.view as unknown as { file?: TFile }).file?.path === file.path);
    if (open) {
      this.app.workspace.revealLeaf(open);
      return;
    }
    void this.app.workspace.openLinkText(rel, "", "tab");
  }

  /** Persist + render a live preview card for a generated file (vault-relative path). */
  private renderArtifactCard(ctx: AssistantCtx, path: string): void {
    ctx.segments.push({ t: "artifact", path });
    this.buildArtifactCard(ctx.bodyEl, path);
  }

  /** Render a preview card for a generated file. HTML → sandboxed iframe preview;
   *  markdown → a capped, faded MarkdownRenderer preview. Resolves the resource /
   *  file fresh so restored transcripts reflect the current on-disk state. */
  private buildArtifactCard(parent: HTMLElement, path: string): void {
    const lower = path.toLowerCase();
    const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
    const file = this.app.vault.getAbstractFileByPath(path);
    const exists = file instanceof TFile;

    const card = parent.createDiv({ cls: "mva-artifact" });
    const head = card.createDiv({ cls: "mva-artifact-head" });
    setIcon(head.createSpan({ cls: "mva-artifact-ico" }), isHtml ? "file-code-2" : "file-text");
    head.createSpan({ cls: "mva-artifact-name", text: noteBasename(path) });
    head.createDiv({ cls: "mva-artifact-spacer" });
    const openAction = () => (isHtml ? this.openArtifactExternally(path) : this.revealNote(path));
    const openBtn = head.createSpan({ cls: "mva-artifact-open", attr: { "aria-label": "Open" } });
    setIcon(openBtn, "external-link");
    openBtn.onclick = (e) => {
      e.stopPropagation();
      openAction();
    };

    // File gone (deleted since the card was created, or an out-of-vault HTML path):
    // markdown shows an explicit note; HTML falls back to a header-only card.
    if (!exists) {
      if (!isHtml) card.createDiv({ cls: "mva-artifact-missing", text: "File deleted" });
      return;
    }

    if (isHtml) {
      const frame = card.createDiv({ cls: "mva-artifact-frame" });
      const iframe = frame.createEl("iframe");
      iframe.setAttr("sandbox", "allow-scripts"); // no allow-same-origin: isolated from the app
      iframe.src = this.app.vault.getResourcePath(file);
      frame.onclick = (e) => {
        e.stopPropagation();
        openAction();
      };
    } else {
      const frame = card.createDiv({ cls: "mva-artifact-frame is-md" });
      const body = frame.createDiv({ cls: "mva-artifact-md markdown-rendered" });
      void this.app.vault
        .cachedRead(file)
        .then((content) => MarkdownRenderer.render(this.app, content.slice(0, 3000), body, path, this))
        .catch(() => {});
      frame.createDiv({ cls: "mva-artifact-fade" });
      frame.onclick = (e) => {
        e.stopPropagation();
        openAction();
      };
    }
  }

  /** Open an HTML artifact in the system browser. In-vault → its app:// resource
   *  URL; outside the vault → the OS shell on the absolute path. */
  private openArtifactExternally(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      window.open(this.app.vault.getResourcePath(file));
      return;
    }
    try {
      const electron = require("electron") as { shell: { openPath(p: string): Promise<string> } };
      void electron.shell.openPath(path);
    } catch {
      new Notice("Couldn't open the artifact.");
    }
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
    this.clickable(head, () => card.toggleClass("is-collapsed", !card.hasClass("is-collapsed")));
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
    this.resetTextStream(ctx);
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

  /* ---------------------- background tasks (F3) --------------------- */

  /** Append a small badge chip to a tool card's head. */
  private addToolBadge(card: HTMLElement, text: string): HTMLElement {
    const head = (card.querySelector(".mva-tool-head") as HTMLElement | null) ?? card;
    return head.createSpan({ cls: "mva-badge-bg", text });
  }

  /** On tool-call-start: badge a background Bash card and link BashOutput/KillShell
   *  cards to their originating background task (presentational only — no polling). */
  private trackBackgroundTask(ctx: AssistantCtx, id: string, name: string, input: unknown): void {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const card = ctx.cards.get(id)?.card;
    if (!card) return;
    if (name === "Bash" && i.run_in_background === true) {
      card.addClass("mva-tool-bg");
      const badge = this.addToolBadge(card, "background");
      ctx.bgTasks.set(id, { cardEl: card, badgeEl: badge });
      return;
    }
    if (name === "BashOutput" || name === "KillShell") {
      const sid =
        (typeof i.bash_id === "string" && i.bash_id) ||
        (typeof i.shell_id === "string" && i.shell_id) ||
        "";
      if (!sid) return;
      for (const task of ctx.bgTasks.values()) {
        if (task.shellId && task.shellId === sid) {
          card.addClass("mva-tool-bg");
          this.addToolBadge(card, "↳ background task");
          task.badgeEl.setText(name === "KillShell" ? "stopped" : "running");
          break;
        }
      }
    }
  }

  /** On tool-call-result of a background Bash: parse the shell id from the CLI
   *  output so later BashOutput/KillShell calls can link back to this task. */
  private linkBackgroundResult(ctx: AssistantCtx, id: string, output: string): void {
    const task = ctx.bgTasks.get(id);
    if (!task) return;
    const sid =
      output.match(/\b(bash_[\w-]+)\b/)?.[1] ||
      output.match(/shell(?:Id)?[:\s]+([\w-]+)/i)?.[1] ||
      output.match(/\bID[:\s]+([\w-]+)/i)?.[1];
    if (sid) task.shellId = sid;
  }

  /* ------------------------ subagents (F4) ------------------------- */

  /** Register a Task card as a nesting target: a collapsed "Subagent activity (N)"
   *  section appended below the card, into which the subagent's tool calls nest. */
  private registerTaskCard(ctx: AssistantCtx, id: string): void {
    const card = ctx.cards.get(id)?.card;
    if (!card) return;
    const container = card.createDiv({ cls: "mva-subagent is-collapsed" });
    const summaryEl = container.createDiv({ cls: "mva-subagent-summary", text: "Subagent activity (0)" });
    const rowsEl = container.createDiv({ cls: "mva-subagent-rows" });
    this.clickable(summaryEl, () => container.toggleClass("is-collapsed", !container.hasClass("is-collapsed")));
    ctx.taskCards.set(id, { container, summaryEl, rowsEl, count: 0 });
  }

  /** Nest a subagent tool call as a mini-row under its parent Task card. Returns
   *  false if the parent isn't tracked, so the caller can fall back to a flat card. */
  private addSubagentRow(ctx: AssistantCtx, parentId: string, id: string, name: string, input: unknown): boolean {
    const task = ctx.taskCards.get(parentId);
    if (!task) return false;
    const meta = toolMeta(name, input);
    const row = task.rowsEl.createDiv({ cls: "mva-subagent-row" });
    const dot = row.createSpan({ cls: "mva-subagent-dot" });
    row.createSpan({ cls: "mva-subagent-tool", text: meta.label });
    if (meta.target) row.createSpan({ cls: "mva-subagent-arg", text: meta.target });
    task.count++;
    task.summaryEl.setText(`Subagent activity (${task.count})`);
    ctx.nestedRows.set(id, { dotEl: dot, parentId });
    this.scrollConvo(ctx.convo);
    return true;
  }

  /** Mark a subagent mini-row ok/error on its result. Returns false if not nested. */
  private resolveSubagentRow(ctx: AssistantCtx, id: string, ok: boolean): boolean {
    const row = ctx.nestedRows.get(id);
    if (!row) return false;
    row.dotEl.addClass(ok ? "is-ok" : "is-error");
    return true;
  }

  /** On the Task's own result, mark its subagent section complete. */
  private markTaskDone(ctx: AssistantCtx, id: string): void {
    const task = ctx.taskCards.get(id);
    if (!task) return;
    task.summaryEl.setText(`Subagent activity (${task.count}) — done`);
  }

  /* -------------------------- permissions --------------------------- */

  /** Signature for the "Always allow" list — argument-aware so allowing one
   *  Bash command (or one file edit) does NOT blanket-approve all of them.
   *  Bash → keyed by the leading command token (the binary); file-mutating
   *  tools → keyed by target path; everything else → the bare tool name. */
  private allowKey(tool: string, input: unknown): string {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (tool === "Bash") {
      const cmd = typeof i.command === "string" ? i.command : "";
      const first = cmd.trim().split(/\s+/)[0] ?? "";
      return first ? `Bash:${first}` : "Bash";
    }
    const fp = toolFilePath(tool, input);
    if (fp && ChatView.WRITE_TOOLS.test(tool)) return `${tool}:${fp}`;
    return tool;
  }

  /** The argument text a permission rule matches against — the full command for
   *  Bash, the target file path for write tools, "" otherwise. Mirrors the
   *  argument axis of allowKey so hand-written and card-created rules agree. */
  private permArgText(tool: string, input: unknown): string {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (tool === "Bash") return typeof i.command === "string" ? i.command.trim() : "";
    const fp = toolFilePath(tool, input);
    if (fp && ChatView.WRITE_TOOLS.test(tool)) return fp;
    return "";
  }

  /** The permission-rule line equivalent to an "Always allow" card choice —
   *  `Tool(argPrefix)` scoped like allowKey (leading command token / target path). */
  private permRuleLine(tool: string, input: unknown): string {
    const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    if (tool === "Bash") {
      const first = (typeof i.command === "string" ? i.command : "").trim().split(/\s+/)[0] ?? "";
      return first ? `Bash(${first})` : "Bash";
    }
    const fp = toolFilePath(tool, input);
    if (fp && ChatView.WRITE_TOOLS.test(tool)) return `${tool}(${fp})`;
    return tool;
  }

  private addPermissionCard(
    ctx: AssistantCtx,
    c: Convo,
    tool: string,
    input: unknown,
    resolve: (d: { behavior: "allow"; remember?: boolean } | { behavior: "deny"; message?: string }) => void
  ): void {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
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
    const alwaysBtn = actions.createEl("button", { cls: "mva-btn", text: "Always allow" });
    const scope =
      tool === "Bash"
        ? `all \`${(((input as Record<string, unknown>)?.command as string) || "").trim().split(/\s+/)[0] || "shell"}\` commands`
        : ChatView.WRITE_TOOLS.test(tool) && toolFilePath(tool, input)
          ? `edits to this file`
          : `this tool`;
    alwaysBtn.setAttr("aria-label", `Always allow ${scope} in this conversation`);
    alwaysBtn.setAttr("title", `Always allow ${scope} in this conversation`);
    alwaysBtn.onclick = () => {
      c.allow.add(this.allowKey(tool, input));
      // Durable across sessions when enabled: append the equivalent rule line.
      if (this.plugin.settings.rememberAlwaysAllow) {
        const line = this.permRuleLine(tool, input);
        const rules = this.plugin.settings.permAllowRules;
        if (!rules.split("\n").some((l) => l.trim() === line)) {
          this.plugin.settings.permAllowRules = (rules.trimEnd() ? rules.trimEnd() + "\n" : "") + line;
          void this.plugin.saveSettings();
        }
      }
      settle({ behavior: "allow", remember: true });
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Deny" }).onclick = () =>
      settle({ behavior: "deny", message: "Denied by user." });
    this.scrollConvo(c);
  }

  /* -------------------------------- ask ----------------------------- */

  /** Bridge invoked by the in-process `ask_user` tool: render an ask card into
   *  the OWNING conversation's in-flight turn and resolve with the user's choices
   *  (header → answer). The owning convo is captured by the per-session server
   *  closure, so parallel conversations can't cross-render.
   *  Rejects if there's no live turn (the tool then reports a graceful dismissal). */
  private askBridge(c: Convo, questions: AskQuestion[]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const ctx = c.currentCtx;
      if (!ctx) {
        reject(new Error("no active turn"));
        return;
      }
      this.renderAskCard(ctx, c, questions, resolve, reject);
    });
  }

  /** Render a structured question card (permission-card pattern). A single
   *  single-select question resolves on click; anything else needs a Submit. */
  private renderAskCard(
    ctx: AssistantCtx,
    c: Convo,
    questions: AskQuestion[],
    resolve: (a: Record<string, string>) => void,
    reject: (e: Error) => void
  ): void {
    this.dropThinking(ctx);
    this.resetTextStream(ctx);
    this.hideWorking(ctx); // the ask card is the feedback while it waits
    this.notifyOnce(ctx, "waiting", "Exo — waiting for you", "The agent asked a question / needs permission.");
    const card = ctx.bodyEl.createDiv({ cls: "mva-ask" });
    const answers: Record<string, string> = {};
    const seg: Segment = { t: "ask", questions, answers };
    ctx.segments.push(seg);

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      c.pendingAsk = null;
      // Collapse to the same compact summary used when the transcript is restored,
      // so live-resolved and reloaded cards look identical.
      this.renderAskSummary(card, questions, answers);
      resolve(answers);
    };
    // Stop (or turn teardown) cancels the card → the tool reports a dismissal.
    c.pendingAsk = () => {
      if (done) return;
      done = true;
      c.pendingAsk = null;
      reject(new Error("cancelled"));
    };

    const selections = questions.map(() => new Set<string>());
    const maybeSubmit = () => {
      if (questions.every((q, i) => selections[i].size > 0)) {
        questions.forEach((q, i) => (answers[q.header] = [...selections[i]].join(", ")));
        finish();
      }
    };

    // Submit is enabled only once every question has a selection (multi-question
    // cards); the single-question single-select case resolves without a Submit.
    let submitBtn: HTMLButtonElement | null = null;
    const allAnswered = () => questions.every((_, i) => selections[i].size > 0);
    const updateSubmit = () => submitBtn?.toggleClass("is-disabled", !allAnswered());

    questions.forEach((q, i) => {
      const qEl = card.createDiv({ cls: "mva-ask-q" });
      const chip = qEl.createSpan({ cls: "mva-ask-chip", text: q.header });
      qEl.createDiv({ cls: "mva-ask-question", text: q.question });
      const opts = qEl.createDiv({ cls: "mva-ask-opts" });
      const single = questions.length === 1 && !q.multiSelect;
      // Only multi-question cards get the per-question answered check.
      const markChip = () => {
        if (questions.length > 1) chip.toggleClass("is-answered", selections[i].size > 0);
      };

      let otherVal = "";
      let otherInput: HTMLInputElement | null = null;

      for (const o of q.options) {
        const b = opts.createEl("button", {
          cls: `mva-ask-opt ${q.multiSelect ? "is-multi" : "is-single"}`,
        });
        b.createSpan({ cls: "mva-ask-ind" });
        const txt = b.createDiv({ cls: "mva-ask-opt-text" });
        txt.createDiv({ cls: "mva-ask-opt-label", text: o.label });
        if (o.description) txt.createDiv({ cls: "mva-ask-opt-desc", text: o.description });
        b.onclick = () => {
          if (q.multiSelect) {
            const sel = !b.hasClass("is-sel");
            b.toggleClass("is-sel", sel);
            if (sel) selections[i].add(o.label);
            else selections[i].delete(o.label);
            markChip();
            updateSubmit();
          } else {
            opts.querySelectorAll(".mva-ask-opt").forEach((x) => (x as HTMLElement).removeClass("is-sel"));
            b.addClass("is-sel");
            selections[i].clear();
            selections[i].add(o.label);
            // Picking a preset option deselects any typed "Other" value.
            if (otherVal) selections[i].delete(otherVal);
            otherVal = "";
            if (otherInput) otherInput.value = "";
            markChip();
            if (single) {
              maybeSubmit();
              return;
            }
            updateSubmit();
          }
        };
      }

      // Ghost "Other…" row at the end — expands an inline input; the typed value
      // participates in the selection exactly like an option label.
      const otherRow = opts.createEl("button", { cls: "mva-ask-opt mva-ask-other-row" });
      setIcon(otherRow.createSpan({ cls: "mva-ask-ind mva-ask-ind-pencil" }), "pencil");
      const otherTxt = otherRow.createDiv({ cls: "mva-ask-opt-text" });
      const otherLabel = otherTxt.createDiv({ cls: "mva-ask-opt-label", text: "Other…" });
      const onOtherInput = () => {
        if (otherVal) selections[i].delete(otherVal);
        otherVal = (otherInput?.value ?? "").trim();
        if (otherVal) {
          if (!q.multiSelect) {
            opts.querySelectorAll(".mva-ask-opt").forEach((x) => (x as HTMLElement).removeClass("is-sel"));
            selections[i].clear();
          }
          selections[i].add(otherVal);
          otherRow.addClass("is-sel");
        } else {
          otherRow.removeClass("is-sel");
        }
        markChip();
        updateSubmit();
      };
      const expandOther = () => {
        if (otherInput) {
          otherInput.focus();
          return;
        }
        otherLabel.remove();
        otherInput = otherTxt.createEl("input", {
          cls: "mva-ask-other",
          attr: { type: "text", placeholder: "Type your answer…" },
        });
        // Clicks inside the input must not re-fire the row's expand handler.
        otherInput.addEventListener("click", (ev) => ev.stopPropagation());
        otherInput.addEventListener("input", onOtherInput);
        // Single-question single-select has no Submit button — let Enter resolve it.
        if (single) {
          otherInput.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
              ev.preventDefault();
              maybeSubmit();
            }
          });
        }
        otherInput.focus();
      };
      otherRow.onclick = () => expandOther();

      // Arrow-key navigation within a question's option rows (Enter/Space are
      // native button activation).
      opts.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
        const rows = Array.from(opts.querySelectorAll<HTMLElement>(".mva-ask-opt"));
        const idx = rows.indexOf(document.activeElement as HTMLElement);
        if (idx < 0) return;
        ev.preventDefault();
        const next = ev.key === "ArrowDown" ? (idx + 1) % rows.length : (idx - 1 + rows.length) % rows.length;
        rows[next].focus();
      });
    });

    if (!(questions.length === 1 && !questions[0].multiSelect)) {
      const actions = card.createDiv({ cls: "mva-ask-actions" });
      submitBtn = actions.createEl("button", { cls: "mva-btn mva-btn-primary is-disabled", text: "Submit" });
      submitBtn.onclick = () => {
        if (!allAnswered()) return;
        questions.forEach((q, i) => (answers[q.header] = [...selections[i]].join(", ")));
        if (Object.values(answers).some((v) => v)) finish();
      };
      updateSubmit();
    }
    this.scrollConvo(c);
  }

  /** Compact resolved view of an ask card: header chip + question + chosen answer
   *  per question. Shared by live-resolve and transcript restore so they match. */
  private renderAskSummary(
    card: HTMLElement,
    questions: AskQuestion[],
    answers: Record<string, string>
  ): void {
    card.empty();
    card.addClass("is-resolved");
    for (const q of questions) {
      const qEl = card.createDiv({ cls: "mva-ask-q" });
      qEl.createSpan({ cls: "mva-ask-chip", text: q.header });
      qEl.createDiv({ cls: "mva-ask-question", text: q.question });
      qEl.createDiv({ cls: "mva-ask-answer", text: `→ ${answers[q.header] ?? "—"}` });
    }
  }

  /* ----------------------------- send ------------------------------- */

  private scrollToBottom(): void {
    this.scrollConvo(this.active);
  }

  /** Scroll a conversation to the bottom — only if it's the visible one AND the
   *  user hasn't scrolled up. Coalesced into one rAF write per frame to avoid
   *  layout thrash during streaming. */
  private scrollConvo(c: Convo): void {
    if (c !== this.active || !this.pinnedToBottom) {
      this.updateJumpPill();
      return;
    }
    if (this.scrollRaf !== null) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = null;
      this.listEl.scrollTop = this.listEl.scrollHeight;
      this.updateJumpPill();
    });
  }

  /** Attach the scroll-position tracker to a conversation's list element. */
  private wireScroll(c: Convo): void {
    this.registerDomEvent(c.listEl, "scroll", () => {
      if (c !== this.active) return;
      const el = c.listEl;
      this.pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      this.updateJumpPill();
    });
  }

  /** Show/hide the floating jump-to-bottom pill based on pin state. */
  private updateJumpPill(): void {
    const show = !this.pinnedToBottom;
    if (show) {
      if (!this.jumpPill) {
        const pill = this.listWrap.createDiv({
          cls: "mva-jump-pill",
          attr: { "aria-label": "Jump to latest" },
        });
        setIcon(pill, "chevron-down");
        this.clickable(pill, () => {
          this.pinnedToBottom = true;
          this.listEl.scrollTop = this.listEl.scrollHeight;
          this.updateJumpPill();
        });
        this.jumpPill = pill;
      }
    } else if (this.jumpPill) {
      this.jumpPill.remove();
      this.jumpPill = null;
    }
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
    c.pendingAsk?.(); // cancel any open ask card
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
    // You always want to watch your own message land.
    this.pinnedToBottom = true;
    this.updateJumpPill();
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
    c.currentCtx = ctx; // target for this conversation's ask_user cards
    c.stopped = false;
    this.setStreaming(c, true);

    // Working indicator (Feature 1): a persistent Claude-Code-style row so the
    // turn never looks dead between send/tools/output. One ticking timer per turn.
    const turnStart = Date.now();
    this.dropThinking(ctx); // the working row replaces the placeholder dots
    this.ensureWorking(ctx);
    const workingTimer = window.setInterval(() => {
      if (ctx.workingElapsed) ctx.workingElapsed.setText(`· ${this.fmtDuration(Date.now() - turnStart)}`);
    }, 1000);

    const adapter = ADAPTERS[c.provider];
    const s = this.plugin.settings;

    // File snapshots taken before this turn's writes, for "Rewind code + conversation".
    const checkpoint: Checkpoint = new Map();
    // Pre-write snapshots are async; collect them so we can guarantee they've all
    // landed before we read/persist the checkpoint at turn end. (In acceptEdits /
    // bypass modes this tool-call-start snapshot is the only one — best-effort, it
    // races the write, but awaiting it keeps the checkpoint complete.)
    const snapshots: Promise<void>[] = [];

    // Watchdog: reset on every event; fire if the turn stalls with no output.
    let timedOut = false;
    // An error_during_execution result resolves the turn (no throw), so the catch's
    // dropSession never runs — the CLI session stays poisoned and every later turn
    // re-errors. Track it here and reset the session at turn end.
    let poisoned = false;
    let watchdog: number | null = null;
    // While an interactive card (permission or ask) is pending, the user may take
    // arbitrarily long to answer — suspend the idle watchdog so it can't fire.
    let pendingInteractive = 0;
    const bump = () => {
      if (pendingInteractive > 0) return; // don't arm while awaiting a user card
      if (watchdog !== null) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        timedOut = true;
        c.session?.interrupt();
      }, IDLE_TIMEOUT);
    };
    const suspendWatchdog = () => {
      pendingInteractive++;
      if (watchdog !== null) {
        window.clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const resumeWatchdog = () => {
      if (pendingInteractive > 0) pendingInteractive--;
      if (pendingInteractive === 0) bump();
    };
    // Tool-use ids of pending ask_user calls, so their result resumes the watchdog.
    const askIds = new Set<string>();

    const onEvent = (e: AgentEvent) => {
      bump();
      switch (e.kind) {
        case "text-delta":
          this.hideWorking(ctx); // the streaming caret takes over
          this.appendText(ctx, e.text);
          break;
        case "thinking-delta":
          this.appendReasoning(ctx, e.text);
          this.setWorkingLabel(ctx, "Thinking…");
          this.ensureWorking(ctx); // re-append last; thinking may be collapsed
          break;
        case "tool-call-start": {
          if (e.name === "TodoWrite") {
            this.renderTodos(ctx, e.input);
            this.ensureWorking(ctx); // keep the row below the todos panel
            break;
          }
          if (e.name === "mcp__obsidian__ask_user") {
            // The card is rendered by askBridge; suspend the watchdog until answered.
            askIds.add(e.id);
            suspendWatchdog();
            this.hideWorking(ctx); // the ask card is the feedback
            break;
          }
          // File tracking runs before the nesting branch: subagent writes must stay
          // rewindable (checkpoint) and visible in the touched-notes footer.
          const fp = toolFilePath(e.name, e.input);
          if (fp) {
            const kind = ChatView.WRITE_TOOLS.test(e.name) ? "write" : "read";
            if (kind === "read") ctx.sources.add(fp);
            else snapshots.push(this.snapshot(checkpoint, fp).catch(() => {})); // checkpoint before the write runs
            if (kind === "write") {
              ctx.writeById.set(e.id, fp);
              // A file that doesn't exist yet at write-start is newly created this turn
              // (drives markdown preview cards; edits of existing notes don't get one).
              const rel = this.relPath(fp);
              if (!this.app.vault.getAbstractFileByPath(rel)) ctx.createdPaths.add(rel);
            }
            mergeTouched(ctx.touched, fp, kind);
          }
          // Feature 4: a subagent's tool call nests under its parent Task card
          // (ephemeral, live-only). Falls through to a flat card if the parent
          // isn't tracked, so nothing is lost.
          if (!(e.parentId && this.addSubagentRow(ctx, e.parentId, e.id, e.name, e.input))) {
            this.addToolCard(ctx, e.id, e.name, e.input);
            if (e.name === "Task") this.registerTaskCard(ctx, e.id);
            this.trackBackgroundTask(ctx, e.id, e.name, e.input);
          }
          // Working row: phase verb from the tool metadata, re-appended last so it
          // stays visible below the tool card during execution.
          this.setWorkingLabel(ctx, toolWorkingLabel(e.name, e.input));
          this.ensureWorking(ctx);
          break;
        }
        case "tool-call-result": {
          if (askIds.has(e.id)) {
            askIds.delete(e.id);
            resumeWatchdog(); // the ask card has been answered/dismissed
            this.setWorkingLabel(ctx, "Thinking…");
            this.ensureWorking(ctx); // the turn continues
            break;
          }
          // Feature 4: a nested subagent result updates its mini-row, not a card —
          // but the reveal path below still runs for nested writes.
          const nested = this.resolveSubagentRow(ctx, e.id, e.ok);
          if (!nested) {
            this.resolveToolCard(ctx, e.id, e.ok, e.output);
            this.linkBackgroundResult(ctx, e.id, e.output);
            this.markTaskDone(ctx, e.id); // Task's own result → mark section done
          }
          const wp = ctx.writeById.get(e.id);
          if (e.ok && wp && this.plugin.settings.revealEditedNotes && !ctx.revealed.has(wp)) {
            ctx.revealed.add(wp);
            this.revealNote(wp);
          }
          // Live preview card: HTML artifacts (any write) + newly-created markdown
          // notes. Dedup per turn on the first successful write of that path.
          if (e.ok && wp) {
            const rel = this.relPath(wp);
            const lower = rel.toLowerCase();
            const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
            const isNewMd = lower.endsWith(".md") && ctx.createdPaths.has(rel);
            if ((isHtml || isNewMd) && !ctx.artifacts.has(rel)) {
              ctx.artifacts.add(rel);
              this.renderArtifactCard(ctx, rel);
            }
          }
          // The text segment (if any) ended before this tool ran — re-show the
          // working row while the agent decides what to do next.
          this.setWorkingLabel(ctx, "Thinking…");
          this.ensureWorking(ctx);
          break;
        }
        case "permission-request": {
          // ask_user is a user interaction, not a gated action — never card it.
          if (e.tool === "mcp__obsidian__ask_user") {
            e.resolve({ behavior: "allow" });
            break;
          }
          const isRead = READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool);
          const fp = toolFilePath(e.tool, e.input);
          // Single source of truth for write-tool classification (WRITE_TOOLS) so
          // checkpointing, touched-footer, and rules can never disagree.
          const isWrite = !!fp && ChatView.WRITE_TOOLS.test(e.tool);
          // Snapshot the target file (pre-edit) before letting a write proceed.
          const allow = (d: { behavior: "allow"; remember?: boolean }) => {
            if (isWrite && fp) void this.snapshot(checkpoint, fp).finally(() => e.resolve(d));
            else e.resolve(d);
          };
          const argText = this.permArgText(e.tool, e.input);
          if (matchPermRule(s.permDenyRules, e.tool, argText)) {
            e.resolve({ behavior: "deny", message: "Denied by an Exo permission rule (settings)." });
          } else if (
            (s.autoAllowRead && isRead) ||
            c.allow.has(this.allowKey(e.tool, e.input)) ||
            matchPermRule(s.permAllowRules, e.tool, argText)
          ) {
            allow({ behavior: "allow" });
          } else if (OBSIDIAN_MEMORY_TOOLS.has(e.tool) && !s.memoryWriteEnabled) {
            e.resolve({ behavior: "deny", message: "Memory writing is disabled in Exo settings." });
          } else {
            // An open permission card also suspends the watchdog while the user decides.
            suspendWatchdog();
            this.hideWorking(ctx); // the card waiting for the user is the feedback
            this.notifyOnce(
              ctx,
              "waiting",
              "Exo — waiting for you",
              "The agent asked a question / needs permission."
            );
            this.addPermissionCard(ctx, c, e.tool, e.input, (d) => {
              resumeWatchdog();
              this.ensureWorking(ctx); // the turn continues once resolved
              if (d.behavior === "allow") allow(d);
              else e.resolve(d);
            });
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
          this.resetTextStream(ctx);
          this.removeWorking(ctx);
          if (c.stopped) {
            // User pressed Stop — the provider reports an execution error as it
            // unwinds; render it as a clean stop, not a scary error.
            ctx.el.addClass("mva-aborted");
            if (!ctx.fullText && ctx.cards.size === 0) {
              ctx.bodyEl.createSpan({ cls: "mva-faint", text: "Stopped." });
            }
          } else {
            // An execution error poisons the CLI session — resuming/reusing it
            // re-errors on every subsequent turn. Reset it at turn end (below).
            poisoned = true;
            this.renderError(ctx, e.message);
            ctx.bodyEl.createSpan({ cls: "mva-faint", text: "The next message starts a fresh session." });
            this.notifyOnce(ctx, "error", "Exo — error", e.message.slice(0, 80));
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
      await Promise.all(snapshots); // ensure every pre-write snapshot landed before we read the checkpoint
      if (timedOut && !ctx.fullText && ctx.cards.size === 0) {
        this.renderError(ctx, `No response — timed out after ${IDLE_TIMEOUT / 1000}s.`);
      }
      this.attachTouched(ctx.el, ctx.touched, checkpoint);
      if (ctx.fullText.trim()) {
        this.attachActions(ctx.el, ctx.fullText, text, c);
        // Turn duration (Feature 2): live-only, only when it's worth showing.
        // Always visible (completion feedback, CC's "Crunched for 2m 49s") — a
        // sibling AFTER the hover-gated actions bar, never inside it.
        const elapsed = Date.now() - turnStart;
        if (elapsed > 5000) {
          ctx.el
            .createDiv({ cls: "mva-turn-meta" })
            .createSpan({ cls: "mva-turn-duration", text: `✻ ${this.fmtDuration(elapsed)}` });
        }
      }
      // Turn finished normally (Feature 3): notify if it ran long and the window
      // is backgrounded. `poisoned` covers an in-band error already handled above.
      if (!c.stopped && !poisoned && Date.now() - turnStart > 10000) {
        const preview = ctx.fullText.trim().slice(0, 80) || "The agent finished working.";
        this.notifyOnce(ctx, "done", "Exo — turn finished", preview);
      }
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
        this.notifyOnce(ctx, "error", "Exo — error", msg.slice(0, 80));
        // Don't replay queued messages into a broken session — they'd just re-fail.
        if (c.queue.length) {
          c.queue = [];
          this.renderQueue(c);
        }
      }
    } finally {
      if (watchdog !== null) window.clearTimeout(watchdog);
      window.clearInterval(workingTimer); // stop the elapsed ticker
      this.removeWorking(ctx); // drop the working row for good
      await Promise.all(snapshots); // finalize the checkpoint even if the turn errored
      // If the turn died with an interactive card still open (session crash while a
      // permission/ask was pending), CANCEL it — otherwise the card stays live in
      // the transcript and the in-process ask promise hangs forever. No-op on clean
      // turns (both are null once answered) and idempotent (done-guarded).
      c.pendingPerm?.();
      c.pendingPerm = null;
      c.pendingAsk?.();
      c.pendingAsk = null;
      c.currentCtx = null; // this turn is over — late ask_user calls reject cleanly
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
      // Background shells can outlive the turn (Exo can't poll them) — note them
      // honestly as "started this turn" rather than claiming a live running count.
      if (ctx.bgTasks.size) {
        const n = ctx.bgTasks.size;
        ctx.el.createDiv({
          cls: "mva-faint mva-bg-foot",
          text: `${n} background task${n > 1 ? "s" : ""} started this turn`,
        });
      }
      c.updatedAt = Date.now();
      // A poisoned session is reused by ensureSession and re-errors forever; drop it
      // (object + resume id) so the next message in this conversation starts clean.
      if (poisoned && !c.stopped) {
        this.dropSession(c);
        c.sessionId = undefined;
      }
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
    setting?.openTabById("exo");
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
