import { App, TFile, prepareSimpleSearch, getAllTags } from "obsidian";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { resolveLink, neighborhood, basename } from "./graph";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const err = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

const MAX_CONTENT = 8000;
const SKIP_LARGER_THAN = 200_000;
const MAX_SCAN_FILES = 2000; // cap the built-in fallback scan (Omnisearch has no such limit)

/** Omnisearch public API (when the plugin is installed). */
interface OmnisearchResult {
  score: number;
  path: string;
  basename: string;
  excerpt?: string;
}
interface OmnisearchApi {
  search(query: string): Promise<OmnisearchResult[]>;
}
function getOmnisearch(app: App): OmnisearchApi | null {
  const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { api?: OmnisearchApi }> } }).plugins;
  const api = plugins?.plugins?.["omnisearch"]?.api;
  return api && typeof api.search === "function" ? api : null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}
function today(): string {
  // Local date (not UTC) — toISOString() would roll to tomorrow late at night in +TZ.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Create any missing parent folders for a vault path (vault.create won't). */
async function ensureParentFolder(app: App, path: string): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return;
  const dir = path.slice(0, slash);
  if (app.vault.getAbstractFileByPath(dir)) return;
  try {
    await app.vault.createFolder(dir);
  } catch {
    /* already exists (race) — fine */
  }
}

/**
 * In-process MCP server exposing Obsidian-native tools to the agent: graph
 * navigation, metadata-aware read/search, convention-aware writes, and
 * `_system/` memory capture. Handlers run in-process and use the Obsidian API
 * (metadataCache/vault/fileManager) — no shell, graph- and frontmatter-aware.
 */
export function createObsidianToolServer(app: App, alwaysLoad = true, memoryWrite = true) {
  const need = (target: string): TFile => {
    const f = resolveLink(app, target);
    if (!f) throw new Error(`Note not found: ${target}`);
    return f;
  };

  /* ----------------------------- read ----------------------------- */

  const searchVault = tool(
    "search_vault",
    "Full-text search across your vault — notes, and with Omnisearch also indexed attachments (PDF/image/canvas). Returns ranked paths with snippets, using Omnisearch (BM25 + fuzzy) when installed, else a built-in scorer. Prefer this over Grep for vault content.",
    { query: z.string(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 10, 30);

      // Preferred path: Omnisearch plugin API (better ranking, fuzzy, attachments).
      const omni = getOmnisearch(app);
      if (omni) {
        try {
          const results = await omni.search(args.query);
          if (results.length === 0) return ok(`No matches for "${args.query}".`);
          return ok(
            results
              .slice(0, limit)
              .map((r) => `- [[${r.path}]] — ${(r.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`)
              .join("\n")
          );
        } catch {
          /* Omnisearch index not ready — fall back to the built-in scorer. */
        }
      }

      const search = prepareSimpleSearch(args.query);
      const hits: { path: string; score: number; snippet: string }[] = [];
      const files = app.vault
        .getMarkdownFiles()
        .filter((f) => f.stat.size <= SKIP_LARGER_THAN)
        .sort((a, b) => b.stat.mtime - a.stat.mtime);
      const scanned = files.slice(0, MAX_SCAN_FILES);
      for (const file of scanned) {
        let text = file.basename;
        try {
          text += "\n" + (await app.vault.cachedRead(file));
        } catch {
          continue; // skip unreadable
        }
        const r = search(text);
        if (r) {
          const at = r.matches[0]?.[0] ?? 0;
          const snippet = text.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, " ").trim();
          hits.push({ path: file.path, score: r.score, snippet });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);
      if (top.length === 0) return ok(`No matches for "${args.query}".`);
      const body = top.map((h) => `- [[${h.path}]] — ${h.snippet}`).join("\n");
      const capped = files.length > MAX_SCAN_FILES
        ? `\n\n(Searched the ${MAX_SCAN_FILES} most recently edited notes of ${files.length}. Install Omnisearch for full-vault search.)`
        : "";
      return ok(body + capped);
    }
  );

  const readNote = tool(
    "read_note",
    "Read a note's content plus its metadata (frontmatter, tags, outgoing links). Accepts a wikilink or vault path.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const cache = app.metadataCache.getFileCache(file);
      const tags = (cache && getAllTags(cache)) || [];
      const fm = cache?.frontmatter ?? {};
      let content = await app.vault.cachedRead(file);
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT) + "\n… (truncated)";
      const meta = [
        `path: ${file.path}`,
        tags.length ? `tags: ${tags.join(", ")}` : "",
        Object.keys(fm).length ? `frontmatter: ${JSON.stringify(fm)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return ok(`${meta}\n\n---\n${content}`);
    }
  );

  const getBacklinks = tool(
    "get_backlinks",
    "List the notes that link TO the given note.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const bl = neighborhood(app, file).backlinks;
      return ok(bl.length ? bl.map((p) => `- [[${p}]]`).join("\n") : "No backlinks.");
    }
  );

  const getNeighborhood = tool(
    "get_neighborhood",
    "Get the graph neighborhood of a note: outgoing links, backlinks, and up/related frontmatter links.",
    { target: z.string() },
    async (args) => {
      const file = need(args.target);
      const n = neighborhood(app, file);
      const fmt = (xs: string[]) => (xs.length ? xs.map((p) => `  - [[${p}]]`).join("\n") : "  (none)");
      return ok(
        `Neighborhood of [[${file.path}]]:\n` +
          `outgoing:\n${fmt(n.outgoing)}\n` +
          `backlinks:\n${fmt(n.backlinks)}\n` +
          `related (up/related):\n${fmt(n.related)}`
      );
    }
  );

  const listNotes = tool(
    "list_notes",
    "List notes filtered by tag (e.g. '#domain/product') and/or folder prefix. Returns paths.",
    { tag: z.string().optional(), folder: z.string().optional(), limit: z.number().optional() },
    async (args) => {
      const limit = Math.min(args.limit ?? 50, 200);
      const wantTag = args.tag?.replace(/^#/, "");
      const out: string[] = [];
      for (const file of app.vault.getMarkdownFiles()) {
        if (args.folder && !file.path.startsWith(args.folder)) continue;
        if (wantTag) {
          const cache = app.metadataCache.getFileCache(file);
          const tags = (cache && getAllTags(cache)) || [];
          if (!tags.some((t) => t.replace(/^#/, "") === wantTag)) continue;
        }
        out.push(file.path);
        if (out.length >= limit) break;
      }
      return ok(out.length ? out.map((p) => `- [[${p}]]`).join("\n") : "No notes matched.");
    }
  );

  const listTags = tool(
    "list_tags",
    "List all tags in the vault with their note counts (most used first).",
    { limit: z.number().optional() },
    async (args) => {
      const counts = new Map<string, number>();
      for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        for (const t of (cache && getAllTags(cache)) || []) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(args.limit ?? 60, 200));
      return ok(sorted.map(([t, c]) => `${t} (${c})`).join("\n") || "No tags.");
    }
  );

  const getActiveContext = tool(
    "get_active_context",
    "Get the note the user is currently viewing, the selected text (if any), and its graph neighborhood.",
    {},
    async () => {
      const file = app.workspace.getActiveFile();
      if (!file) return ok("No active note.");
      const n = neighborhood(app, file);
      const sel =
        app.workspace.activeEditor?.editor?.getSelection?.() ?? "";
      return ok(
        `active: [[${file.path}]]\n` +
          (sel ? `selection:\n${sel}\n` : "") +
          `related: ${[...n.related, ...n.backlinks].slice(0, 8).map(basename).join(", ") || "(none)"}`
      );
    }
  );

  /* ----------------------------- write ---------------------------- */

  const createNote = tool(
    "create_note",
    "Create a new note. Provide tags in frontmatter following the vault's tag system (#type/*, #domain/*). Fails if the note exists.",
    {
      path: z.string().describe("Vault path ending in .md"),
      content: z.string(),
      frontmatter: z.record(z.string(), z.any()).optional(),
    },
    async (args) => {
      const path = args.path.endsWith(".md") ? args.path : `${args.path}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const file = await app.vault.create(path, args.content);
      const fm = args.frontmatter ?? {};
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        Object.assign(f, fm);
        if (!f.tags) f.tags = ["type/note"];
      });
      return ok(`Created [[${path}]]`);
    }
  );

  const appendToNote = tool(
    "append_to_note",
    "Append text to the end of an existing note.",
    { target: z.string(), text: z.string() },
    async (args) => {
      const file = need(args.target);
      await app.vault.append(file, `\n${args.text}\n`);
      return ok(`Appended to [[${file.path}]]`);
    }
  );

  const updateFrontmatter = tool(
    "update_frontmatter",
    "Merge keys into a note's YAML frontmatter (safe, structure-preserving).",
    { target: z.string(), changes: z.record(z.string(), z.any()) },
    async (args) => {
      const file = need(args.target);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        Object.assign(f, args.changes);
      });
      return ok(`Updated frontmatter of [[${file.path}]]`);
    }
  );

  const addLinks = tool(
    "add_links",
    "Add wikilinks to a note's `related` frontmatter (deduped). Use to connect notes in the graph.",
    { target: z.string(), targets: z.array(z.string()) },
    async (args) => {
      const file = need(args.target);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        const cur = new Set<string>(Array.isArray(f.related) ? (f.related as string[]) : []);
        for (const t of args.targets) cur.add(`[[${t.replace(/^\[\[|\]\]$/g, "")}]]`);
        f.related = [...cur];
      });
      return ok(`Linked ${args.targets.length} note(s) from [[${file.path}]]`);
    }
  );

  const openNote = tool(
    "open_note",
    "Open a note in the Obsidian UI for the user.",
    { target: z.string() },
    async (args) => {
      await app.workspace.openLinkText(args.target.replace(/^\[\[|\]\]$/g, ""), "", false);
      return ok(`Opened ${args.target}`);
    }
  );

  const editNote = tool(
    "edit_note",
    "Replace text in an existing note (Obsidian-native, link/frontmatter-safe). Fails if old_string is absent, or ambiguous unless replace_all is set. Prefer this over the built-in Edit for vault notes.",
    { target: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() },
    async (args) => {
      const file = need(args.target);
      const content = await app.vault.read(file);
      const count = args.old_string ? content.split(args.old_string).length - 1 : 0;
      if (count === 0) return err(`Text not found in ${file.path}.`);
      if (count > 1 && !args.replace_all) return err(`old_string appears ${count}× — pass replace_all or make it unique.`);
      let next: string;
      if (args.replace_all) {
        next = content.split(args.old_string).join(args.new_string);
      } else {
        const i = content.indexOf(args.old_string);
        next = content.slice(0, i) + args.new_string + content.slice(i + args.old_string.length);
      }
      await app.vault.modify(file, next);
      return ok(`Edited [[${file.path}]]`);
    }
  );

  const insertAtCursor = tool(
    "insert_at_cursor",
    "Insert text at the user's cursor in the active note (replaces the current selection if any). Use to write directly where the user is working.",
    { text: z.string() },
    async (args) => {
      const editor = app.workspace.activeEditor?.editor;
      if (!editor) return err("No active editor to insert into.");
      editor.replaceSelection(args.text);
      return ok("Inserted at cursor.");
    }
  );

  const renameNote = tool(
    "rename_note",
    "Rename or move a note, updating all backlinks across the vault (Obsidian-native). Fails if the destination already exists.",
    { target: z.string(), new_path: z.string() },
    async (args) => {
      const file = need(args.target);
      const dest = args.new_path.endsWith(".md") ? args.new_path : `${args.new_path}.md`;
      if (app.vault.getAbstractFileByPath(dest)) return err(`Already exists: ${dest}`);
      await ensureParentFolder(app, dest);
      await app.fileManager.renameFile(file, dest);
      return ok(`Renamed to [[${dest}]]`);
    }
  );

  /* --------------------------- memory ----------------------------- */

  const captureDecision = tool(
    "capture_decision",
    "Record a decision into _system/memory/decisions/ following the vault's decision-record convention.",
    {
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      rationale: z.string(),
      options: z.string().optional(),
      revisit: z.string().optional(),
      domain: z.string().optional(),
    },
    async (args) => {
      const path = `_system/memory/decisions/${today()}-${slugify(args.title)}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const body =
        `# Decision: ${args.title}\n\n` +
        `## Contesto\n${args.context}\n\n` +
        (args.options ? `## Opzioni considerate\n${args.options}\n\n` : "") +
        `## Decisione\n${args.decision}\n\n` +
        `## Razionale\n${args.rationale}\n\n` +
        (args.revisit ? `## Revisitare se\n${args.revisit}\n` : "");
      const file = await app.vault.create(path, body);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        f.type = "decision";
        f.created_by = "exo";
        f.created = today();
        f.tags = ["type/decision", ...(args.domain ? [`domain/${args.domain.replace(/^#?domain\//, "")}`] : [])];
      });
      return ok(`Captured decision → [[${path}]]`);
    }
  );

  const logSession = tool(
    "log_session",
    "Prepend an entry to _system/memory/session-log.md. type ∈ ingest|query|decision|lint|build|triage.",
    { title: z.string(), summary: z.string(), type: z.string().optional() },
    async (args) => {
      const path = "_system/memory/session-log.md";
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const entry = `## [${stamp}] ${args.type ?? "query"} | ${args.title}\n\n${args.summary}\n\n`;
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const cur = await app.vault.read(file);
        await app.vault.modify(file, entry + cur);
      } else {
        await ensureParentFolder(app, path);
        await app.vault.create(path, entry);
      }
      return ok("Logged session entry.");
    }
  );

  const captureLearning = tool(
    "capture_learning",
    "Record a learning/pattern into _system/memory/learnings/.",
    { title: z.string(), observation: z.string(), evidence: z.string().optional(), context: z.string().optional() },
    async (args) => {
      const path = `_system/memory/learnings/${today()}-${slugify(args.title)}.md`;
      if (app.vault.getAbstractFileByPath(path)) return err(`Already exists: ${path}`);
      await ensureParentFolder(app, path);
      const body =
        `# Learning: ${args.title}\n\n` +
        `## Osservazione\n${args.observation}\n\n` +
        (args.evidence ? `## Evidenza\n${args.evidence}\n\n` : "") +
        (args.context ? `## Contesto\n${args.context}\n` : "");
      const file = await app.vault.create(path, body);
      await app.fileManager.processFrontMatter(file, (f: Record<string, unknown>) => {
        f.type = "memory";
        f.created_by = "exo";
        f.created = today();
        f.tags = ["type/memory"];
      });
      return ok(`Captured learning → [[${path}]]`);
    }
  );

  return createSdkMcpServer({
    name: "obsidian",
    version: "1.0.0",
    alwaysLoad,
    instructions:
      "Obsidian-native tools. Prefer these over generic file/Bash tools for vault work — they respect links, tags, and frontmatter.",
    tools: [
      searchVault, readNote, getBacklinks, getNeighborhood, listNotes, listTags, getActiveContext,
      createNote, appendToNote, updateFrontmatter, addLinks, openNote,
      editNote, insertAtCursor, renameNote,
      ...(memoryWrite ? [captureDecision, logSession, captureLearning] : []),
    ],
  });
}

/** Read-only obsidian tools that can be auto-allowed without a permission card. */
export const OBSIDIAN_READ_TOOLS = new Set([
  "mcp__obsidian__search_vault",
  "mcp__obsidian__read_note",
  "mcp__obsidian__get_backlinks",
  "mcp__obsidian__get_neighborhood",
  "mcp__obsidian__list_notes",
  "mcp__obsidian__list_tags",
  "mcp__obsidian__get_active_context",
]);

/** Memory-write tool names (gated separately by the memoryWrite setting). */
export const OBSIDIAN_MEMORY_TOOLS = new Set([
  "mcp__obsidian__capture_decision",
  "mcp__obsidian__log_session",
  "mcp__obsidian__capture_learning",
]);
