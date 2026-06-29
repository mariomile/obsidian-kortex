/** Read-only tools that can be auto-allowed (no side effects). */
export const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

export interface ToolMeta {
  icon: string; // lucide icon id
  label: string;
  target: string; // short context (file path, command, pattern…)
  /** Vault path to open when the target is clicked (file tools only). */
  openPath?: string;
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The raw file path a tool operates on, if any (for click-to-open). */
export function toolFilePath(name: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(name)) return undefined;
  const i = rec(input);
  const p = asString(i.file_path || i.notebook_path);
  return p || undefined;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rec(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/** Short, human label + target for a tool call. */
export function toolMeta(name: string, input: unknown): ToolMeta {
  return { ...baseMeta(name, input), openPath: toolFilePath(name, input) };
}

function baseMeta(name: string, input: unknown): Omit<ToolMeta, "openPath"> {
  const i = rec(input);
  // MCP tools arrive as mcp__server__tool
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { icon: "plug", label: parts.slice(2).join(" ") || name, target: parts[1] ?? "" };
  }
  switch (name) {
    case "Read":
      return { icon: "file-text", label: "Read", target: basename(asString(i.file_path)) };
    case "Write":
      return { icon: "file-plus", label: "Write", target: basename(asString(i.file_path)) };
    case "Edit":
    case "MultiEdit":
      return { icon: "file-pen-line", label: "Edit", target: basename(asString(i.file_path)) };
    case "NotebookEdit":
      return { icon: "file-pen-line", label: "Edit notebook", target: basename(asString(i.notebook_path)) };
    case "Bash":
      return { icon: "terminal", label: "Run command", target: truncate(asString(i.command), 60) };
    case "Glob":
      return { icon: "search", label: "Find files", target: asString(i.pattern) };
    case "Grep":
      return { icon: "search", label: "Search", target: asString(i.pattern) };
    case "LS":
      return { icon: "folder", label: "List", target: asString(i.path) };
    case "WebFetch":
      return { icon: "globe", label: "Fetch URL", target: truncate(asString(i.url), 50) };
    case "WebSearch":
      return { icon: "globe", label: "Web search", target: asString(i.query) };
    case "TodoWrite":
      return { icon: "list-checks", label: "Update todos", target: "" };
    case "Task":
      return { icon: "bot", label: "Subagent", target: asString(i.description) };
    default:
      return { icon: "wrench", label: name, target: "" };
  }
}

/** Render the detail body for a tool (diff / command / params). */
export function renderToolDetail(el: HTMLElement, name: string, input: unknown, _result: unknown): void {
  const i = rec(input);
  if (name === "Edit") {
    renderDiff(el, asString(i.old_string), asString(i.new_string));
    return;
  }
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    for (const e of i.edits as Array<Record<string, unknown>>) {
      renderDiff(el, asString(e.old_string), asString(e.new_string));
    }
    return;
  }
  if (name === "Write") {
    renderDiff(el, "", asString(i.content));
    return;
  }
  if (name === "Bash") {
    const pre = el.createEl("pre", { cls: "mva-code" });
    pre.createEl("code", { text: asString(i.command) });
    if (i.description) el.createDiv({ cls: "mva-tool-note", text: asString(i.description) });
    return;
  }
  // Generic: a couple of meaningful params.
  const keys = Object.keys(i).filter((k) => i[k] != null && typeof i[k] !== "object");
  if (keys.length) {
    const dl = el.createDiv({ cls: "mva-params" });
    for (const k of keys.slice(0, 4)) {
      const row = dl.createDiv({ cls: "mva-param" });
      row.createSpan({ cls: "mva-param-k", text: k });
      row.createSpan({ cls: "mva-param-v", text: truncate(asString(i[k]), 120) });
    }
  }
}

function renderDiff(el: HTMLElement, oldStr: string, newStr: string): void {
  const pre = el.createEl("pre", { cls: "mva-diff" });
  if (oldStr) {
    for (const line of oldStr.split("\n")) {
      pre.createDiv({ cls: "mva-diff-line mva-del", text: "- " + line });
    }
  }
  for (const line of newStr.split("\n")) {
    pre.createDiv({ cls: "mva-diff-line mva-add", text: "+ " + line });
  }
}

function basename(p: string): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}
