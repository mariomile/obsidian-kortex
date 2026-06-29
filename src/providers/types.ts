import type { ResolvedCli } from "../cli";

export type ProviderId = "claude" | "codex";

export interface ModelOption {
  id: string; // value passed to the CLI ("" / "default" = CLI default)
  label: string;
}

/** Permission decision returned to the CLI for a tool-use request (Phase 2). */
export type PermissionDecision =
  | { behavior: "allow"; remember?: boolean }
  | { behavior: "deny"; message?: string };

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/**
 * Normalized event stream produced by every provider adapter, so the chat UI is
 * provider-agnostic. Phase 1 emits text-delta / turn-end / error; the tool and
 * permission events are wired in Phase 2.
 */
export type AgentEvent =
  | { kind: "text-delta"; text: string }
  | { kind: "thinking-delta"; text: string }
  | { kind: "tool-call-start"; id: string; name: string; input: unknown }
  | { kind: "tool-call-result"; id: string; ok: boolean; output: string }
  | {
      kind: "permission-request";
      id: string;
      tool: string;
      input: unknown;
      resolve: (d: PermissionDecision) => void;
    }
  | { kind: "usage"; usage: ContextUsage }
  | { kind: "turn-end"; sessionId?: string }
  | { kind: "error"; message: string };

export interface ContextUsage {
  used: number;
  total: number;
}

/** Everything fixed for the lifetime of a conversation session. */
export interface SessionOpts {
  cli: ResolvedCli;
  /** Model id, or "" / "default" for the CLI's configured default. */
  model: string;
  /** Reasoning effort: "default" | low | medium | high | xhigh | max. */
  effort: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Working directory for the agent — the vault root. */
  cwd: string;
  permissionMode: PermissionMode;
  /** Whether tools (Read/Write/Edit/Bash/…) are enabled at all. */
  toolsEnabled: boolean;
  /** Skip global hooks + MCP servers for faster cold start. */
  fastStartup: boolean;
  /** Resume a prior on-disk session id when (re)creating the session. */
  resumeSessionId?: string;
}

/**
 * A live conversation. For Claude this wraps a single long-lived SDK `query()`
 * in streaming-input mode — follow-up turns reuse the same process/context
 * (no per-message cold start). For Codex it spawns `codex exec` per turn.
 */
export interface AgentSession {
  /** Send one user turn; resolves when that turn completes. */
  send(message: string, onEvent: (e: AgentEvent) => void): Promise<void>;
  /** Interrupt the in-flight turn. */
  interrupt(): void;
  /** Tear down the session (kills any live process). */
  dispose(): void;
  /** Current context-window usage, if the provider exposes it. */
  contextUsage(): Promise<ContextUsage | null>;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Fixed brand accent, theme-independent. */
  brandColor: string;
  models(): ModelOption[];
  createSession(opts: SessionOpts): AgentSession;
}
