import { App, TFile } from "obsidian";

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);

/** Hard ceiling on the assembled preamble so a large vault can't blow the context budget. */
const MAX_BOOT = 9000;
/** Cap the rules list so a vault with dozens of rule files stays bounded. */
const MAX_RULES = 40;

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

  const ruleFiles = app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith("_system/memory/rules/"));
  const rules = ruleFiles.slice(0, MAX_RULES).map((f) => `- ${f.basename}`);
  if (ruleFiles.length > MAX_RULES) rules.push(`- …and ${ruleFiles.length - MAX_RULES} more`);
  if (rules.length) parts.push(`### Active rules (read the file for detail)\n${rules.join("\n")}`);

  const log = await read("_system/memory/session-log.md", 1200);
  if (log) parts.push(`### Recent sessions\n${log}`);

  if (!parts.length) return "";

  return cap(
    [
      "## Vault memory — you are Kortex, embedded in this Obsidian vault.",
      "Honor these conventions: prefer the `mcp__obsidian__*` tools for vault operations (they respect links/tags/frontmatter); follow the tag system (#type/*, #status/*, #domain/*) and the object schema; use [[wikilinks]] for internal references; never create files at the vault root.",
      ...parts,
    ].join("\n\n"),
    MAX_BOOT
  );
}
