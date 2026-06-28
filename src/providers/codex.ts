import { spawn } from "child_process";
import { makeAbortError } from "../cli";
import type { AgentEvent, ModelOption, ProviderAdapter, SendOpts } from "./types";

/**
 * Codex CLI adapter via `codex exec --json` (JSONL events on stdout).
 *
 * Phase 1: text streaming only, read-only sandbox. The JSONL event schema is
 * version-sensitive, so we parse defensively (handle both `msg`-wrapped and
 * flat shapes) and refine tool/approval handling in Phase 3.
 */
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

  send(opts: SendOpts, onEvent: (e: AgentEvent) => void): Promise<void> {
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", opts.cwd];

    // Sandbox: Phase 1 (no tools) → read-only. Phase 2 agentic → workspace-write.
    args.push("-s", opts.toolsEnabled ? "workspace-write" : "read-only");
    if (opts.model && opts.model !== "default") args.push("-m", opts.model);

    // Resume a prior session for a continuous conversation.
    if (opts.sessionId) {
      args.splice(1, 0, "resume", opts.sessionId);
      // → ["exec","resume","<id>","--json",...]
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        fn();
      };

      const child = spawn(opts.cli.bin, args, {
        cwd: opts.cwd,
        env: { ...process.env, PATH: opts.cli.pathEnv },
      });

      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      if (opts.signal.aborted) onAbort();
      opts.signal.addEventListener("abort", onAbort);

      let buf = "";
      let stderr = "";
      let sessionId: string | undefined;
      let streamed = false;
      let finalText = "";

      child.on("error", (err) => finish(() => reject(err)));

      child.stdout.on("data", (chunk: Buffer | string) => {
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
          if (sid) sessionId = sid;

          if (type === "agent_message_delta" && typeof msg.delta === "string") {
            streamed = true;
            onEvent({ kind: "text-delta", text: msg.delta });
          } else if (type === "agent_reasoning_delta" && typeof msg.delta === "string") {
            onEvent({ kind: "thinking-delta", text: msg.delta });
          } else if (type === "agent_message" && typeof msg.message === "string") {
            finalText = msg.message;
          } else if (type === "exec_command_begin") {
            // Codex runs shell commands inside its sandbox (workspace-write).
            const id = String(msg.call_id ?? msg.id ?? `cx-${Date.now()}`);
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

      child.stderr.on("data", (d: Buffer | string) => {
        stderr += d.toString();
      });

      child.on("close", (code) =>
        finish(() => {
          if (opts.signal.aborted) {
            reject(makeAbortError());
          } else if (code !== 0) {
            const m = stderr.trim() || `codex exited with code ${code ?? "null"}`;
            onEvent({ kind: "error", message: m });
            reject(new Error(m));
          } else {
            if (!streamed && finalText) onEvent({ kind: "text-delta", text: finalText });
            onEvent({ kind: "turn-end", sessionId });
            resolve();
          }
        })
      );

      child.stdin.on("error", () => {
        /* broken pipe — handled via close/error */
      });
      child.stdin.write(opts.message);
      child.stdin.end();
    });
  },
};
