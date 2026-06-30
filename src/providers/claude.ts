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
  private onEvent: ((e: AgentEvent) => void) | null = null;
  private resolveTurn: (() => void) | null = null;
  private rejectTurn: ((e: unknown) => void) | null = null;
  private sessionId?: string;
  private permSeed = 0;
  /** Force-deny callback for an in-flight permission request, so interrupt/dispose
   *  unblock the SDK (otherwise parked waiting for canUseTool to resolve → turn hangs). */
  private denyPending: (() => void) | null = null;

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
          const sys = [opts.systemPrompt, opts.memoryPreamble].filter(Boolean).join("\n\n");
          return sys ? { systemPrompt: sys } : {};
        })(),
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
        pathToClaudeCodeExecutable: opts.cli.bin,
        includePartialMessages: true,
        // In-process Obsidian tools (if enabled). strictMcpConfig keeps only
        // this server (no external MCP) for a fast, predictable cold start.
        ...(opts.obsidianServer
          ? {
              mcpServers: {
                obsidian: opts.obsidianServer as import("@anthropic-ai/claude-agent-sdk").McpServerConfig,
              },
            }
          : {}),
        ...(opts.fastStartup
          ? { disableAllHooks: true, strictMcpConfig: true, ...(opts.obsidianServer ? {} : { mcpServers: {} }) }
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
              ...(opts.nativeFirst && opts.obsidianServer
                ? { disallowedTools: NATIVE_FIRST_DISALLOW }
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
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.denyPending?.();
      this.onEvent?.({ kind: "error", message: m });
      this.settleTurn(err instanceof Error ? err : new Error(m));
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
      for (const b of msg.message?.content ?? []) {
        if (b.type === "tool_use") {
          emit({ kind: "tool-call-start", id: b.id ?? "", name: b.name ?? "", input: b.input });
        }
      }
    } else if (msg.type === "user") {
      const c = msg.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === "tool_result") {
            emit({
              kind: "tool-call-result",
              id: b.tool_use_id ?? "",
              ok: !b.is_error,
              output: stringifyToolResult(b.content),
            });
          }
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype && msg.subtype !== "success") {
        emit({ kind: "error", message: msg.result || `Claude ended: ${msg.subtype}` });
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
    // Guard against overlapping turns: a second send() while one is in flight would
    // orphan the first promise (its resolve/reject would be overwritten).
    if (this.resolveTurn) return Promise.reject(new Error("A turn is already in flight."));
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
    this.safeInterrupt();
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
    this.safeInterrupt();
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
    return [
      { id: "", label: "Default" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
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
