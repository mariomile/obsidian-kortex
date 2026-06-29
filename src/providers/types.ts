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
  | { kind: "turn-end"; sessionId?: string }
  | { kind: "error"; message: string };

export interface SendOpts {
  cli: ResolvedCli;
  /** Model id, or "" / "default" for the CLI's configured default. */
  model: string;
  /** Reasoning effort: "default" | low | medium | high | xhigh | max. */
  effort: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** The user's message text. */
  message: string;
  /** Previous session id to resume, if any (continuous conversation). */
  sessionId?: string;
  /** Working directory for the agent — the vault root. */
  cwd: string;
  /** Permission posture. Phase 1 chat ignores tools entirely. */
  permissionMode: PermissionMode;
  /** Whether tools (Read/Write/Edit/Bash/…) are enabled at all. */
  toolsEnabled: boolean;
  /** Skip global hooks + MCP servers for faster cold start. */
  fastStartup: boolean;
  signal: AbortSignal;
}

export interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  /** Fixed brand accent, theme-independent. */
  brandColor: string;
  models(): ModelOption[];
  /** Stream a turn. Resolves when the turn completes; rejects on error/abort. */
  send(opts: SendOpts, onEvent: (e: AgentEvent) => void): Promise<void>;
}
