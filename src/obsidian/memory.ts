import { App, TFile } from "obsidian";

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/**
 * Compose a concise "memory preamble" from the vault's `_system/` layer so the
 * agent boots with Mario's context, preferences, and active rules. The agent can
 * read deeper on demand via the read_note tool.
 */
export async function readBootContext(app: App): Promise<string> {
  const read = async (path: string, max: number): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      try {
        return cap(await app.vault.cachedRead(f), max);
      } catch {
        /* ignore */
      }
    }
    return "";
  };

  const parts: string[] = [];
  const ctx = await read("_system/vault-context.md", 3500);
  if (ctx) parts.push(`### Vault context\n${ctx}`);
  const prefs = await read("_system/memory/preferences/preferences.md", 2500);
  if (prefs) parts.push(`### Preferences\n${prefs}`);

  const rules = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith("_system/memory/rules/"))
    .map((f) => `- ${f.basename}`);
  if (rules.length) parts.push(`### Active rules (read the file for detail)\n${rules.join("\n")}`);

  const log = await read("_system/memory/session-log.md", 1200);
  if (log) parts.push(`### Recent sessions\n${log}`);

  if (!parts.length) return "";

  return [
    "## Vault memory — you are Kortex, embedded in this Obsidian vault.",
    "Honor these conventions: prefer the `mcp__obsidian__*` tools for vault operations (they respect links/tags/frontmatter); follow the tag system (#type/*, #status/*, #domain/*) and the object schema; use [[wikilinks]] for internal references; never create files at the vault root.",
    ...parts,
  ].join("\n\n");
}
