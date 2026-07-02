import { App, FileSystemAdapter, TFile } from "obsidian";
import { resolveCli, describeError } from "./cli";
import { ADAPTERS } from "./providers/registry";
import type { AgentEvent } from "./providers/types";
import { createObsidianToolServer, OBSIDIAN_READ_TOOLS } from "./obsidian/tools";
import { READ_ONLY_TOOLS, toolFilePath } from "./ui/tools";
import type { MVASettings } from "./settings";

/** Per-step idle timeout — no event for this long aborts the run (bounded autonomy). */
const STEP_IDLE_TIMEOUT = 180_000;

export interface HeadlessResult {
  ok: boolean;
  output: string;      // concatenated assistant text (per-step headers when multi-step)
  reads: string[];     // vault paths the agent read (for the report footer)
  error?: string;
}

function vaultPath(app: App): string {
  const a = app.vault.adapter;
  return a instanceof FileSystemAdapter ? a.getBasePath() : "";
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Run a playbook headlessly: the agent may READ the vault (read-only tools
 * auto-allowed), every mutating tool is auto-denied. Multi-step (" >>> ")
 * playbooks run sequentially in one session. Returns the text; writes nothing.
 */
export async function runHeadlessPlaybook(
  app: App,
  settings: MVASettings,
  prompt: string
): Promise<HeadlessResult> {
  const provider = settings.provider;
  const bin = provider === "claude" ? settings.claudeBin : settings.codexBin;
  const steps = prompt.split(/\s+>>>\s+/).map((s) => s.trim()).filter(Boolean);
  const reads = new Set<string>();
  let output = "";

  let session: import("./providers/types").AgentSession | null = null;
  try {
    const cli = await resolveCli(provider, bin);
    session = ADAPTERS[provider].createSession({
      cli,
      model: provider === "claude" ? settings.claudeModel : settings.codexModel,
      effort: settings.effort,
      cwd: vaultPath(app),
      permissionMode: "default",
      toolsEnabled: true, // reads allowed; writes denied by the auto-resolver / sandbox
      fastStartup: true,
      // Claude: in-process vault tools, memory-write OFF.
      obsidianServer:
        provider === "claude" && settings.obsidianToolsEnabled
          ? createObsidianToolServer(app, true, false)
          : undefined,
      // Codex: the sandbox is the gate — force read-only, never ask (nothing can answer).
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });

    for (let i = 0; i < steps.length; i++) {
      let stepText = "";
      let watchdog: number | null = null;
      const bump = () => {
        if (watchdog !== null) window.clearTimeout(watchdog);
        watchdog = window.setTimeout(() => session?.interrupt(), STEP_IDLE_TIMEOUT);
      };
      const onEvent = (e: AgentEvent) => {
        bump();
        if (e.kind === "text-delta") stepText += e.text;
        else if (e.kind === "tool-call-start") {
          const fp = toolFilePath(e.name, e.input);
          if (fp) reads.add(fp);
        } else if (e.kind === "permission-request") {
          if (READ_ONLY_TOOLS.has(e.tool) || OBSIDIAN_READ_TOOLS.has(e.tool)) {
            e.resolve({ behavior: "allow" });
          } else {
            e.resolve({ behavior: "deny", message: "Headless playbook runs are read-only." });
          }
        }
      };
      bump();
      try {
        await session.send(steps[i], onEvent);
      } finally {
        if (watchdog !== null) window.clearTimeout(watchdog);
      }
      output += steps.length > 1 ? `\n\n## Step ${i + 1}\n\n${stepText.trim()}` : stepText.trim();
    }
    return { ok: true, output: output.trim(), reads: [...reads] };
  } catch (err) {
    return {
      ok: false,
      output: output.trim(),
      reads: [...reads],
      error: describeError(err, ADAPTERS[provider].displayName),
    };
  } finally {
    session?.dispose();
  }
}

/** Write the run report to _system/reports/ and return its vault path. */
export async function writeReport(app: App, name: string, result: HeadlessResult): Promise<string> {
  const dir = "_system/reports";
  if (!app.vault.getAbstractFileByPath(dir)) {
    try {
      await app.vault.createFolder(dir);
    } catch {
      /* exists (race) */
    }
  }
  const safe = name.replace(/[\\/:#^[\]|?]/g, "").trim() || "Playbook";
  let path = `${dir}/${today()} ${safe}.md`;
  if (app.vault.getAbstractFileByPath(path)) {
    const d = new Date();
    path = `${dir}/${today()} ${safe} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}.md`;
  }
  const body =
    `# ${name}\n\n` +
    (result.ok ? "" : `> [!warning] Run ended with an error: ${result.error ?? "unknown"}\n\n`) +
    `${result.output || "_(no output)_"}\n` +
    (result.reads.length
      ? `\n---\n**Read:** ${result.reads.map((p) => `[[${p}]]`).join(" · ")}\n`
      : "");
  const file = await app.vault.create(path, body);
  await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
    f.type = "report";
    f.created_by = "exo";
    f.date = today();
    f.tags = ["type/note"];
  });
  return path;
}
