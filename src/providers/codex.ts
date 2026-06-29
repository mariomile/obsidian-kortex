import { spawn, type ChildProcess } from "child_process";
import type {
  AgentEvent,
  AgentSession,
  ContextUsage,
  ModelOption,
  ProviderAdapter,
  SessionOpts,
} from "./types";

/**
 * Codex session. Codex has no persistent streaming-input protocol wired here,
 * so each turn spawns `codex exec --json`, resuming the prior session id for
 * conversation continuity. Tools run inside Codex's sandbox (workspace-write).
 */
class CodexSession implements AgentSession {
  private child: ChildProcess | null = null;
  private sessionId?: string;

  constructor(private opts: SessionOpts) {
    this.sessionId = opts.resumeSessionId;
  }

  send(message: string, onEvent: (e: AgentEvent) => void): Promise<void> {
    const o = this.opts;
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", o.cwd];
    if (this.sessionId) args.splice(1, 0, "resume", this.sessionId);
    args.push("-s", o.toolsEnabled ? "workspace-write" : "read-only");
    if (o.model && o.model !== "default") args.push("-m", o.model);
    if (o.effort && o.effort !== "default") args.push("-c", `model_reasoning_effort="${o.effort}"`);
    if (o.fastStartup) args.push("-c", "mcp_servers={}");

    return new Promise<void>((resolve, reject) => {
      const child = spawn(o.cli.bin, args, {
        cwd: o.cwd,
        env: { ...process.env, PATH: o.cli.pathEnv },
      });
      this.child = child;

      let buf = "";
      let stderr = "";
      let streamed = false;
      let finalText = "";

      child.on("error", (err) => reject(err));

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          const msg = (obj.msg ?? obj) as Record<string, unknown>;
          const type = String(msg.type ?? "");
          const sid = (obj.session_id ?? msg.session_id) as string | undefined;
          if (sid) this.sessionId = sid;

          if (type === "agent_message_delta" && typeof msg.delta === "string") {
            streamed = true;
            onEvent({ kind: "text-delta", text: msg.delta });
          } else if (type === "agent_reasoning_delta" && typeof msg.delta === "string") {
            onEvent({ kind: "thinking-delta", text: msg.delta });
          } else if (type === "agent_message" && typeof msg.message === "string") {
            finalText = msg.message;
          } else if (type === "exec_command_begin") {
            const id = String(msg.call_id ?? msg.id ?? "cx");
            const command = Array.isArray(msg.command)
              ? (msg.command as unknown[]).join(" ")
              : String(msg.command ?? "");
            onEvent({ kind: "tool-call-start", id, name: "Bash", input: { command } });
          } else if (type === "exec_command_end") {
            const id = String(msg.call_id ?? msg.id ?? "");
            const out = String(msg.aggregated_output ?? msg.stdout ?? msg.output ?? "");
            onEvent({ kind: "tool-call-result", id, ok: Number(msg.exit_code ?? 0) === 0, output: out });
          } else if (type === "patch_apply_begin") {
            const changes = (msg.changes ?? {}) as Record<string, unknown>;
            for (const path of Object.keys(changes)) {
              onEvent({
                kind: "tool-call-start",
                id: `${msg.call_id ?? "patch"}:${path}`,
                name: "Edit",
                input: { file_path: path },
              });
            }
          } else if (type === "patch_apply_end") {
            const changes = (msg.changes ?? {}) as Record<string, unknown>;
            const ok = msg.success !== false;
            for (const path of Object.keys(changes)) {
              onEvent({ kind: "tool-call-result", id: `${msg.call_id ?? "patch"}:${path}`, ok, output: "" });
            }
          } else if (type === "error" && typeof msg.message === "string") {
            onEvent({ kind: "error", message: msg.message });
          }
        }
      });

      child.stderr?.on("data", (d: Buffer | string) => (stderr += d.toString()));

      child.on("close", (code) => {
        this.child = null;
        if (code !== 0 && code !== null) {
          const m = stderr.trim() || `codex exited with code ${code}`;
          onEvent({ kind: "error", message: m });
          // Don't hard-reject on non-zero (e.g. interrupted) — end the turn.
        }
        if (!streamed && finalText) onEvent({ kind: "text-delta", text: finalText });
        onEvent({ kind: "turn-end", sessionId: this.sessionId });
        resolve();
      });

      child.stdin?.on("error", () => {
        /* broken pipe — handled via close */
      });
      child.stdin?.write(message);
      child.stdin?.end();
    });
  }

  interrupt(): void {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    this.interrupt();
  }

  async contextUsage(): Promise<ContextUsage | null> {
    return null;
  }
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  displayName: "Codex",
  brandColor: "#19c37d",

  models(): ModelOption[] {
    return [
      { id: "", label: "Default" },
      { id: "gpt-5-codex", label: "GPT-5 Codex" },
      { id: "o3", label: "o3" },
    ];
  },

  createSession(opts: SessionOpts): AgentSession {
    return new CodexSession(opts);
  },
};
