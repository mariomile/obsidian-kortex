import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ModelOption,
  ProviderAdapter,
  SessionOpts,
} from "./types";

/** Built-in file tools disabled in "native-first" mode (use Obsidian tools). */
const NATIVE_FIRST_DISALLOW = ["Read", "Grep", "Glob", "LS", "Edit", "MultiEdit", "Write", "NotebookEdit"];

/** All standard tools — denied when tools are off (pure chat). */
const ALL_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "NotebookEdit",
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "SlashCommand",
];

/**
 * A persistent Claude conversation: one long-lived SDK `query()` driven in
 * streaming-input mode. Follow-up turns push into the same input stream, so the
 * CLI process and context stay warm — no per-message cold start.
 */
type UserContent = string | Array<Record<string, unknown>>;

class ClaudeSession implements AgentSession {
  private q: Query;
  private queue: { role: "user"; content: UserContent }[] = [];
  private wake: (() => void) | null = null;
  private disposed = false;
  /** True once the SDK message stream has ended (CLI process gone). A dead session
   *  can never emit a `result`, so sends against it must fail fast instead of
   *  parking forever (the view drops the session and the next message starts fresh). */
  private ended = false;
  private onEvent: ((e: AgentEvent) => void) | null = null;
  private resolveTurn: (() => void) | null = null;
  private rejectTurn: ((e: unknown) => void) | null = null;
  private sessionId?: string;
  private permSeed = 0;
  /** Force-deny callback for an in-flight permission request, so interrupt/dispose
   *  unblock the SDK (otherwise parked waiting for canUseTool to resolve → turn hangs). */
  private denyPending: (() => void) | null = null;
  /** Per-turn tail of CLI stderr lines, surfaced when a turn ends in an error whose
   *  `result` is empty (e.g. error_during_execution). Cleared at the start of send(). */
  private stderrTail: string[] = [];

  constructor(opts: SessionOpts) {
    this.sessionId = opts.resumeSessionId;
    const self = this;
    async function* input(): AsyncGenerator<{
      type: "user";
      message: { role: "user"; content: UserContent };
      parent_tool_use_id: null;
    }> {
      while (!self.disposed) {
        if (self.queue.length === 0) {
          await new Promise<void>((r) => (self.wake = r));
          if (self.disposed) return;
        }
        const message = self.queue.shift()!;
        yield { type: "user", message, parent_tool_use_id: null };
      }
    }

    this.q = query({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prompt: input() as any,
      options: {
        cwd: opts.cwd,
        ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
        ...(opts.effort && opts.effort !== "default"
          ? { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" }
          : {}),
        ...(opts.autoCompact ? { autoCompactEnabled: true } : {}),
        ...(() => {
          // Use Claude Code's OWN default system prompt (tool discipline,
          // conciseness — which keeps token use down — plan/todo behavior, and a
          // cache-friendly prefix) and APPEND Exo's memory + optional user prompt.
          // Passing a bare string here would REPLACE CC's system prompt, turning the
          // agent into a raw, more verbose Claude that behaves nothing like CC.
          const append = [opts.systemPrompt, opts.memoryPreamble].filter(Boolean).join("\n\n");
          return {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              ...(append ? { append } : {}),
            },
          };
        })(),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        pathToClaudeCodeExecutable: opts.cli.bin,
        includePartialMessages: true,
        // Keep a short tail of CLI stderr so an opaque execution error (empty
        // `result`) can still surface actionable detail. Bounded ring buffer.
        stderr: (data: string) => {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            this.stderrTail.push(t.length > 400 ? t.slice(0, 400) + "…" : t);
            if (this.stderrTail.length > 12) this.stderrTail.shift();
          }
        },
        // In-process Obsidian tools (if enabled). strictMcpConfig keeps only
        // this server (no external MCP) for a fast, predictable cold start.
        ...(opts.obsidianServer
          ? {
              mcpServers: {
                obsidian: opts.obsidianServer as import("@anthropic-ai/claude-agent-sdk").McpServerConfig,
              },
            }
          : {}),
        // Hooks are controlled solely by runHooks (CC parity — CC runs hooks by
        // default). Fast startup now only skips external MCP servers.
        ...(opts.runHooks ? {} : { disableAllHooks: true }),
        ...(opts.fastStartup
          ? { strictMcpConfig: true, ...(opts.obsidianServer ? {} : { mcpServers: {} }) }
          : {}),
        ...(opts.toolsEnabled
          ? {
              permissionMode: opts.permissionMode,
              canUseTool: (toolName, toolInput, ctx) =>
                new Promise((resolve) => {
                  const suggestions = ctx?.suggestions;
                  let settled = false;
                  const finish = (d: import("./types").PermissionDecision) => {
                    if (settled) return;
                    settled = true;
                    this.denyPending = null;
                    if (d.behavior === "allow") {
                      resolve({
                        behavior: "allow",
                        updatedInput: toolInput,
                        ...(d.remember && suggestions ? { updatedPermissions: suggestions } : {}),
                      });
                    } else {
                      resolve({ behavior: "deny", message: d.message || "Denied by user." });
                    }
                  };
                  // If the turn is interrupted/disposed while this is pending, deny so the
                  // SDK can unwind and emit a result (instead of parking forever).
                  this.denyPending = () => finish({ behavior: "deny", message: "Interrupted." });
                  this.onEvent?.({
                    kind: "permission-request",
                    id: `perm-${++this.permSeed}`,
                    tool: toolName,
                    input: toolInput,
                    resolve: finish,
                  });
                }),
              // When the Obsidian server is active, disable the SDK's UI-less
              // built-in AskUserQuestion (our mcp__obsidian__ask_user replaces it),
              // plus the native file tools in native-first mode. One key, emitted once.
              ...(opts.obsidianServer
                ? {
                    disallowedTools: [
                      ...(opts.nativeFirst ? NATIVE_FIRST_DISALLOW : []),
                      "AskUserQuestion",
                    ],
                  }
                : {}),
            }
          : { disallowedTools: ALL_TOOLS }),
      },
    });

    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q as AsyncIterable<ClaudeMsg>) {
        if (this.disposed) break;
        this.route(msg);
      }
      // The stream can complete WITHOUT a `result` for an in-flight turn (CLI
      // process exited mid-turn). Nothing else will ever settle that send() —
      // the view would wait forever with the composer stuck on "streaming".
      // No-op when the turn already settled or on dispose (handles are null).
      this.denyPending?.();
      this.settleTurn(new Error("Claude session ended unexpectedly."));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.denyPending?.();
      this.onEvent?.({ kind: "error", message: m });
      this.settleTurn(err instanceof Error ? err : new Error(m));
    } finally {
      this.ended = true;
    }
  }

  private route(msg: ClaudeMsg): void {
    if (msg.session_id) this.sessionId = msg.session_id;
    const emit = this.onEvent;
    if (!emit) return;

    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      emit({ kind: "compact", summary: msg.compact_summary });
      return;
    }
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev?.type === "content_block_delta") {
        if (ev.delta?.type === "text_delta" && ev.delta.text) {
          emit({ kind: "text-delta", text: ev.delta.text });
        } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          emit({ kind: "thinking-delta", text: ev.delta.thinking });
        }
      }
    } else if (msg.type === "assistant") {
      // Subagent (Task) tool activity carries the parent Task's tool_use id so the
      // view can nest it under that card instead of rendering flat top-level cards.
      const pid = msg.parent_tool_use_id ?? undefined;
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          emit({ kind: "tool-call-start", id: b.id ?? "", name: b.name ?? "", input: b.input, parentId: pid });
        }
      }
    } else if (msg.type === "user") {
      const pid = msg.parent_tool_use_id ?? undefined;
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") {
            emit({
              kind: "tool-call-result",
              id: b.tool_use_id ?? "",
              ok: !b.is_error,
              output: stringifyToolResult(b.content),
              parentId: pid,
            });
          }
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype && msg.subtype !== "success") {
        let message = msg.result || `Claude ended: ${msg.subtype}`;
        if (this.stderrTail.length) {
          message += "\n\nCLI stderr (tail):\n" + this.stderrTail.slice(-6).join("\n");
        }
        emit({ kind: "error", message });
      }
      emit({ kind: "turn-end", sessionId: this.sessionId });
      this.settleTurn();
      // Context usage is a control round-trip — fetch after the turn resolves
      // so it never delays the UI; emit when (and if) it returns.
      void this.contextUsage().then((u) => {
        if (u) emit({ kind: "usage", usage: u });
      });
    }
  }

  /** Resolve (or reject) the in-flight turn exactly once and clear its handles. */
  private settleTurn(err?: unknown): void {
    const resolve = this.resolveTurn;
    const reject = this.rejectTurn;
    this.resolveTurn = this.rejectTurn = null;
    if (err !== undefined) reject?.(err);
    else resolve?.();
  }

  send(
    message: string,
    onEvent: (e: AgentEvent) => void,
    images?: import("./types").ImageAttachment[]
  ): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Session disposed."));
    // A dead stream can never answer: fail fast so the view drops this session
    // and the next message starts a fresh one (instead of parking forever — the
    // idle-session variant of this is a pre-warmed CLI that died while idle).
    if (this.ended) return Promise.reject(new Error("Claude session ended — sending again starts a fresh session."));
    // Guard against overlapping turns: a second send() while one is in flight would
    // orphan the first promise (its resolve/reject would be overwritten).
    if (this.resolveTurn) return Promise.reject(new Error("A turn is already in flight."));
    this.stderrTail = []; // per-turn tail — drop any lines from a prior turn
    this.onEvent = onEvent;
    const content: UserContent =
      images && images.length
        ? [
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.mediaType, data: img.dataB64 },
            })),
            { type: "text", text: message },
          ]
        : message;
    return new Promise<void>((resolve, reject) => {
      this.resolveTurn = resolve;
      this.rejectTurn = reject;
      this.queue.push({ role: "user", content });
      const w = this.wake;
      this.wake = null;
      w?.();
    });
  }

  /** Change the permission mode live (e.g. toggling plan mode). */
  setPermissionMode(mode: import("./types").PermissionMode): void {
    if (this.disposed) return;
    try {
      const p = this.q.setPermissionMode?.(mode);
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /** Trigger conversation compaction via the CLI's /compact command. */
  compact(): void {
    if (this.disposed) return;
    this.queue.push({ role: "user", content: "/compact" });
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Call q.interrupt() and swallow both sync throws and promise rejections
   *  (it rejects when the query has already ended — harmless). */
  private safeInterrupt(): void {
    try {
      const p = this.q.interrupt?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  interrupt(): void {
    if (this.disposed) return;
    // Unblock a pending permission first so the SDK can unwind and emit a result.
    this.denyPending?.();
    // Only interrupt when a turn is actually running — calling q.interrupt() on an
    // idle/closed transport throws "ProcessTransport is not ready for writing".
    if (this.resolveTurn) this.safeInterrupt();
  }

  dispose(): void {
    if (this.disposed) return; // idempotent — dispose may be called more than once
    this.disposed = true;
    this.denyPending?.();
    try {
      this.wake?.();
    } catch {
      /* ignore */
    }
    // Interrupt only if a turn is in flight (avoids the transport error on idle teardown).
    if (this.resolveTurn) this.safeInterrupt();
    // The pump loop breaks on `disposed` without emitting a result, so settle here
    // to ensure any awaiting send() promise is released.
    this.settleTurn(new Error("Session disposed."));
  }

  async contextUsage(): Promise<ContextUsage | null> {
    try {
      const u = await this.q.getContextUsage?.();
      if (u && typeof u.totalTokens === "number" && typeof u.maxTokens === "number" && u.maxTokens > 0) {
        return { used: u.totalTokens, total: u.maxTokens };
      }
    } catch {
      /* not available */
    }
    return null;
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  displayName: "Claude",
  brandColor: "#d97757",

  models(): ModelOption[] {
    // Pinned, verified-accessible model IDs (checked 2026-07-01 against the
    // installed `claude` CLI). Add newer ones here as they ship. Users can also
    // type any custom model id in settings.
    return [
      { id: "", label: "Default" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new ClaudeSession(opts);
  },
};

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : ""))
      .join("");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface ClaudeMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  result?: string;
  compact_summary?: string;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: {
    content?: Array<{
      type?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}
