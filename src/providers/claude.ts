import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeAbortError } from "../cli";
import type { AgentEvent, ModelOption, ProviderAdapter, SendOpts } from "./types";

/** All standard tools — denied when tools are off (pure chat). */
const ALL_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "NotebookEdit",
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "SlashCommand",
];

let permCounter = 0;

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

  async send(opts: SendOpts, onEvent: (e: AgentEvent) => void): Promise<void> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (opts.signal.aborted) ac.abort();
    opts.signal.addEventListener("abort", onAbort);

    let sessionId: string | undefined = opts.sessionId;

    try {
      const q = query({
        prompt: opts.message,
        options: {
          cwd: opts.cwd,
          ...(opts.model && opts.model !== "default" ? { model: opts.model } : {}),
          ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
          ...(opts.sessionId ? { resume: opts.sessionId } : {}),
          pathToClaudeCodeExecutable: opts.cli.bin,
          // NOTE: we intentionally do NOT pass `settingSources: []`. Isolation
          // mode mangles a cwd containing a dot (e.g. "marioverse.ai" →
          // "marioverse-ai"), making the agent write to a phantom directory.
          // Loading the default sources keeps the cwd literal. The trade-off:
          // tools the user already allowlisted in their Claude config won't
          // re-prompt — our canUseTool gate fires for everything else
          // (Edit/Write/unlisted Bash). That's the safe, expected behavior.
          includePartialMessages: true,
          abortController: ac,
          stderr: () => {
            /* swallow CLI stderr noise; errors surface via result */
          },
          ...(opts.toolsEnabled
            ? {
                permissionMode: opts.permissionMode,
                canUseTool: (toolName, input, ctx) =>
                  new Promise((resolve) => {
                    const suggestions = ctx?.suggestions;
                    onEvent({
                      kind: "permission-request",
                      id: `perm-${++permCounter}`,
                      tool: toolName,
                      input,
                      resolve: (d) => {
                        if (d.behavior === "allow") {
                          resolve({
                            behavior: "allow",
                            updatedInput: input,
                            ...(d.remember && suggestions ? { updatedPermissions: suggestions } : {}),
                          });
                        } else {
                          resolve({ behavior: "deny", message: d.message || "Denied by user." });
                        }
                      },
                    });
                  }),
              }
            : { disallowedTools: ALL_TOOLS }),
        },
      });

      for await (const msg of q as AsyncIterable<ClaudeMsg>) {
        if (opts.signal.aborted) break;
        if (msg.session_id) sessionId = msg.session_id;

        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev?.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              onEvent({ kind: "text-delta", text: ev.delta.text });
            } else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
              onEvent({ kind: "thinking-delta", text: ev.delta.thinking });
            }
          }
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "tool_use") {
              onEvent({
                kind: "tool-call-start",
                id: block.id ?? "",
                name: block.name ?? "",
                input: block.input,
              });
            }
          }
        } else if (msg.type === "user") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                onEvent({
                  kind: "tool-call-result",
                  id: block.tool_use_id ?? "",
                  ok: !block.is_error,
                  output: stringifyToolResult(block.content),
                });
              }
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype && msg.subtype !== "success") {
            const m = msg.result || `Claude ended: ${msg.subtype}`;
            onEvent({ kind: "error", message: m });
          }
        }
      }

      if (opts.signal.aborted) throw makeAbortError();
      onEvent({ kind: "turn-end", sessionId });
    } catch (err) {
      if (opts.signal.aborted) throw makeAbortError();
      const m = err instanceof Error ? err.message : String(err);
      onEvent({ kind: "error", message: m });
      throw err instanceof Error ? err : new Error(m);
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
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

/* Loosely-typed view of the SDK messages we consume. */
interface ClaudeMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
  };
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
