import { App } from "obsidian";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import type { MVASettings } from "../settings";

interface NamedItem {
  name: string;
  desc?: string;
}

const BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite",
];
const FILE_BUILTINS = new Set(["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit"]);
const NATIVE_READ = ["search_vault", "read_note", "get_backlinks", "get_neighborhood", "list_notes", "list_tags", "get_active_context"];
const NATIVE_WRITE = ["create_note", "append_to_note", "update_frontmatter", "add_links", "open_note", "edit_note", "insert_at_cursor", "rename_note"];
const NATIVE_MEMORY = ["capture_decision", "log_session", "capture_learning"];

/* ----------------------------- gathering ------------------------------ */

async function scanNames(dir: string): Promise<{ folders: string[]; mds: string[] }> {
  const out = { folders: [] as string[], mds: [] as string[] };
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.folders.push(e.name);
      else if (e.name.endsWith(".md")) out.mds.push(e.name.replace(/\.md$/, ""));
    }
  } catch {
    /* missing dir */
  }
  return out;
}

/** Read `name:` / `description:` from a markdown file's frontmatter. */
async function readAgentMeta(file: string): Promise<NamedItem | null> {
  try {
    const raw = (await readFile(file, "utf8")).slice(0, 1500);
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    const fm = m ? m[1] : raw;
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const base = file.split("/").pop()!.replace(/\.md$/, "");
    return { name: name || base, desc: desc?.slice(0, 110) };
  } catch {
    return null;
  }
}

async function gatherFromScopes(sub: "skills" | "agents" | "commands"): Promise<NamedItem[]> {
  const seen = new Set<string>();
  const items: NamedItem[] = [];
  const roots = [`${homedir()}/.claude/${sub}`]; // global
  const add = (name: string, desc?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push({ name, desc });
  };
  for (const root of roots) {
    const { folders, mds } = await scanNames(root);
    for (const f of folders) add(f);
    for (const md of mds) {
      if (sub === "agents") {
        const meta = await readAgentMeta(`${root}/${md}.md`);
        add(meta?.name ?? md, meta?.desc);
      } else add(md);
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function gatherFromVault(app: App, sub: string): Promise<NamedItem[]> {
  const items: NamedItem[] = [];
  try {
    const res = await app.vault.adapter.list(`.claude/${sub}`);
    for (const f of res.folders) items.push({ name: f.split("/").pop() ?? f });
    for (const f of res.files) {
      if (!f.endsWith(".md")) continue;
      const base = f.split("/").pop()!.replace(/\.md$/, "");
      if (sub === "agents") {
        let desc: string | undefined;
        let name = base;
        try {
          const raw = (await app.vault.adapter.read(f)).slice(0, 1500);
          const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
          name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") || base;
          desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")?.slice(0, 110);
        } catch {
          /* ignore */
        }
        items.push({ name, desc });
      } else items.push({ name: base });
    }
  } catch {
    /* missing */
  }
  return items;
}

function mergeByName(a: NamedItem[], b: NamedItem[]): NamedItem[] {
  const map = new Map<string, NamedItem>();
  for (const it of [...a, ...b]) if (!map.has(it.name)) map.set(it.name, it);
  return [...map.values()].sort((x, y) => x.name.localeCompare(y.name));
}

async function gatherMcpServers(app: App): Promise<string[]> {
  const names = new Set<string>();
  const tryFile = async (path: string) => {
    try {
      const json = JSON.parse(await readFile(path, "utf8")) as { mcpServers?: Record<string, unknown> };
      for (const k of Object.keys(json.mcpServers ?? {})) names.add(k);
    } catch {
      /* missing / unreadable / not JSON — ignore */
    }
  };
  await tryFile(`${homedir()}/.claude.json`);
  // project .mcp.json lives at the vault root
  const base = (app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
  if (base) await tryFile(`${base}/.mcp.json`);
  return [...names].sort();
}

interface HookSummary {
  event: string; // PreToolUse, PostToolUse, SessionStart, Notification, …
  count: number; // number of matcher entries under that event
}

/** Read the `hooks` object from a Claude settings.json, tolerating missing/invalid JSON. */
async function gatherHooks(path: string): Promise<HookSummary[]> {
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as { hooks?: Record<string, unknown> };
    const out: HookSummary[] = [];
    for (const [event, matchers] of Object.entries(json.hooks ?? {})) {
      out.push({ event, count: Array.isArray(matchers) ? matchers.length : 0 });
    }
    return out;
  } catch {
    /* missing / unreadable / not JSON — ignore */
    return [];
  }
}

/* ----------------------------- rendering ------------------------------ */

interface Ctx {
  provider: string;
  model: string;
  onOpenNote: (path: string) => void;
}

export async function renderCapabilitiesPanel(
  container: HTMLElement,
  app: App,
  s: MVASettings,
  ctx: Ctx
): Promise<void> {
  container.empty();
  container.createDiv({ cls: "mva-gallery-title", text: "Capabilities" });
  const grid = container.createDiv({ cls: "mva-caps" });

  const claude = ctx.provider === "claude";
  const agentic = s.toolsEnabled;
  const nativeOn = s.obsidianToolsEnabled && agentic && claude;

  const card = (title: string, sub?: string): HTMLElement => {
    const c = grid.createDiv({ cls: "mva-caps-card" });
    const h = c.createDiv({ cls: "mva-caps-head" });
    h.createSpan({ cls: "mva-caps-title", text: title });
    if (sub) h.createSpan({ cls: "mva-caps-sub", text: sub });
    return c.createDiv({ cls: "mva-caps-body" });
  };
  const chip = (parent: HTMLElement, label: string, active: boolean, desc?: string, onClick?: () => void) => {
    const el = parent.createSpan({ cls: `mva-caps-chip ${active ? "is-on" : "is-off"}` });
    el.createSpan({ cls: "mva-caps-dot" });
    el.createSpan({ text: label });
    if (desc) el.setAttr("aria-label", desc), el.setAttr("title", desc);
    if (onClick) {
      el.addClass("is-clickable");
      el.onclick = onClick;
    }
  };
  const empty = (parent: HTMLElement, text: string) => parent.createDiv({ cls: "mva-faint", text });
  const tier = (label: string) => {
    const t = grid.createDiv({ cls: "mva-caps-tier" });
    t.setText(label);
    t.style.fontSize = "10.5px";
    t.style.textTransform = "uppercase";
    t.style.letterSpacing = "0.06em";
    t.style.color = "var(--text-muted)";
    t.style.fontWeight = "600";
    t.style.marginTop = "6px";
  };

  // Session
  tier("Session");
  {
    const b = card("Session");
    chip(b, `Provider: ${ctx.provider}`, true);
    chip(b, `Model: ${ctx.model || "default"}`, true);
    chip(b, `Effort: ${s.effort}`, true);
    chip(b, `Permissions: ${s.permissionMode}`, true);
    chip(b, "Agentic tools", agentic);
    chip(b, "Fast startup", s.fastStartup);
    chip(b, "Native-first", s.nativeFirst);
  }

  // Knowledge
  tier("Knowledge");
  // Memory
  {
    const b = card("Vault memory", "_system/");
    chip(b, "Read at boot", s.memoryReadEnabled && claude);
    chip(b, "Write (gated)", s.memoryWriteEnabled && claude);
    const open = (p: string) => () => ctx.onOpenNote(p);
    chip(b, "vault-context.md", true, "open", open("_system/vault-context.md"));
    chip(b, "preferences.md", true, "open", open("_system/memory/preferences/preferences.md"));
    chip(b, "session-log.md", true, "open", open("_system/memory/session-log.md"));
  }

  // Playbooks
  tier("Playbooks");
  // Playbooks (custom prompts; " >>> " = multi-step workflow)
  {
    const b = card("Playbooks", "custom prompts + workflows");
    const prompts = s.customPrompts ?? [];
    const scheduled = new Set(
      (s.scheduledRuns ?? "")
        .split("\n")
        .map((l) => l.slice(0, l.lastIndexOf("|")).trim().toLowerCase())
        .filter(Boolean)
    );
    if (!prompts.length) empty(b, "No playbooks yet — add custom prompts in settings.");
    for (const p of prompts) {
      const isWorkflow = p.prompt.includes(" >>> ");
      const isSched = scheduled.has(p.name.toLowerCase());
      const steps = isWorkflow ? p.prompt.split(/\s+>>>\s+/).filter(Boolean).length : 0;
      const label = isSched ? `${p.name} ⏱` : p.name;
      const desc = isWorkflow ? `workflow · ${steps} steps` : "prompt";
      chip(b, label, true, isSched ? `${desc} · scheduled` : desc);
    }
  }

  // Commands
  {
    const b = card("Commands", ".claude/commands");
    const cmds = mergeByName(await gatherFromVault(app, "commands"), await gatherFromScopes("commands"));
    if (!cmds.length) empty(b, "None found.");
    for (const cm of cmds) chip(b, `/${cm.name}`, true);
  }

  // Sub-agents
  {
    const b = card("Sub-agents", ".claude/agents");
    const agents = mergeByName(await gatherFromVault(app, "agents"), await gatherFromScopes("agents"));
    if (!agents.length) empty(b, "None found.");
    for (const a of agents) chip(b, a.name, true, a.desc);
  }

  // Skills & Tools
  tier("Skills & Tools");
  // Skills
  {
    const b = card("Skills", ".claude/skills");
    const skills = mergeByName(await gatherFromVault(app, "skills"), await gatherFromScopes("skills"));
    if (!skills.length) empty(b, "None found.");
    for (const sk of skills) chip(b, sk.name, true);
  }

  // Hooks
  {
    const b = card("Hooks", ".claude/settings.json");
    if (!s.runHooks) chip(b, "Disabled in settings", false, "Turn on 'Run Claude Code hooks' in settings");
    const base = (app.vault.adapter as unknown as { getBasePath?(): string }).getBasePath?.();
    const vaultHooks = base ? await gatherHooks(`${base}/.claude/settings.json`) : [];
    const globalHooks = await gatherHooks(`${homedir()}/.claude/settings.json`);
    const addScope = (list: HookSummary[], scope: string) => {
      if (!list.length) return;
      b.createSpan({ cls: "mva-faint", text: scope });
      for (const h of list) chip(b, `${h.event} ×${h.count}`, s.runHooks, scope);
    };
    if (!vaultHooks.length && !globalHooks.length) {
      empty(
        b,
        "No hooks configured. Hooks in .claude/settings.json run automatically (PreToolUse guards, formatters, notifications)."
      );
    } else {
      addScope(vaultHooks, "vault");
      addScope(globalHooks, "global");
      b.createDiv({
        cls: "mva-faint",
        text: "Hooks run at session start and per tool call — they add latency if slow.",
      });
    }
  }

  // Tools
  {
    const b = card("Tools", "built-in + Obsidian-native");
    for (const t of BUILTIN_TOOLS) {
      const active = agentic && !(s.nativeFirst && claude && FILE_BUILTINS.has(t));
      chip(b, t, active);
    }
    if (nativeOn) {
      for (const t of NATIVE_READ) chip(b, t, true);
      for (const t of NATIVE_WRITE) chip(b, t, true);
      for (const t of NATIVE_MEMORY) chip(b, t, s.memoryWriteEnabled, "memory write");
    }
  }

  // MCP
  {
    const b = card("MCP servers");
    chip(b, "obsidian (in-process)", nativeOn);
    const external = await gatherMcpServers(app);
    if (external.length) {
      for (const n of external) chip(b, n, !s.fastStartup, s.fastStartup ? "disabled by Fast startup" : "active");
    } else if (!nativeOn) {
      empty(b, "No MCP servers active.");
    }
    if (s.fastStartup && external.length) b.createDiv({ cls: "mva-faint", text: "External MCP is off while Fast startup is on." });
  }
}
