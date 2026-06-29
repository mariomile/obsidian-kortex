import { App, TFile, getAllTags } from "obsidian";

/** Resolve a wikilink, link text, or vault path to a TFile. */
export function resolveLink(app: App, linkOrPath: string, sourcePath = ""): TFile | null {
  const raw = (linkOrPath || "").trim();
  if (!raw) return null;
  const direct = app.vault.getAbstractFileByPath(raw);
  if (direct instanceof TFile) return direct;
  const stripped = raw
    .replace(/^\[\[/, "")
    .replace(/\]\]$/, "")
    .split("|")[0]
    .split("#")[0]
    .trim();
  return app.metadataCache.getFirstLinkpathDest(stripped, sourcePath);
}

/** Outgoing resolved links from a file. */
export function outgoing(app: App, file: TFile): string[] {
  const links = app.metadataCache.resolvedLinks[file.path] || {};
  return Object.keys(links);
}

/** Files that link TO this file (no public API — derived from resolvedLinks). */
export function backlinks(app: App, file: TFile): string[] {
  const out: string[] = [];
  const rl = app.metadataCache.resolvedLinks;
  for (const src in rl) {
    if (rl[src][file.path]) out.push(src);
  }
  return out;
}

/** Wikilinks declared in `up:` / `related:` frontmatter. */
export function relatedFromFrontmatter(app: App, file: TFile): string[] {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) return [];
  const out: string[] = [];
  for (const key of ["up", "related"]) {
    const v = (fm as Record<string, unknown>)[key];
    if (!v) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const item of arr) {
      const f = resolveLink(app, String(item), file.path);
      if (f && !out.includes(f.path)) out.push(f.path);
    }
  }
  return out;
}

export interface Neighborhood {
  outgoing: string[];
  backlinks: string[];
  related: string[];
}

export function neighborhood(app: App, file: TFile): Neighborhood {
  return {
    outgoing: outgoing(app, file),
    backlinks: backlinks(app, file),
    related: relatedFromFrontmatter(app, file),
  };
}

/** Unique, ranked "related notes" for surfacing (related > backlinks > outgoing). */
export function relatedNotes(app: App, file: TFile, limit = 8): string[] {
  const n = neighborhood(app, file);
  const seen = new Set<string>([file.path]);
  const out: string[] = [];
  for (const p of [...n.related, ...n.backlinks, ...n.outgoing]) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export function tagsOf(app: App, file: TFile): string[] {
  const cache = app.metadataCache.getFileCache(file);
  return cache ? getAllTags(cache) ?? [] : [];
}

export function basename(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}
