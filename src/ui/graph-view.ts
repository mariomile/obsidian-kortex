import { basename } from "../obsidian/graph";

export interface TouchedNote {
  path: string;
  kind: "read" | "write";
}

/**
 * Conservatively turn plain-text mentions of the given note basenames into
 * [[wikilinks]]. Scoped to the notes actually involved this turn (small, safe).
 * Skips fenced code blocks and existing links.
 */
export function wikilinkify(md: string, paths: string[]): string {
  if (!paths.length) return md;
  const names = [...new Set(paths.map(basename))].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length);
  if (!names.length) return md;
  // Protected (odd) segments: fenced code, inline code, existing [[wikilinks]],
  // and markdown links/images [text](url) — never rewrite basenames inside these.
  const parts = md.split(/(```[\s\S]*?```|`[^`]*`|\[\[[^\]]*\]\]|!?\[[^\]]*\]\([^)]*\))/g);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (let i = 0; i < parts.length; i++) {
    // even indices are normal text; odd indices are code/links (left untouched)
    if (i % 2 === 1) continue;
    for (const name of names) {
      const re = new RegExp(`(?<![\\w/])${esc(name)}(?![\\w/])`, "g");
      let linked = false;
      parts[i] = parts[i].replace(re, (m) => {
        if (linked) return m; // one link per name per segment
        linked = true;
        return `[[${name}]]`;
      });
    }
  }
  return parts.join("");
}
