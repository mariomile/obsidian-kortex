import { App, TFile, setIcon } from "obsidian";
import { neighborhood, basename } from "../obsidian/graph";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Render a collapsible backlinks/outgoing/related panel for a note. */
export function renderNeighborhoodPanel(
  container: HTMLElement,
  app: App,
  file: TFile | null,
  onOpen: (path: string) => void
): void {
  container.empty();
  if (!file) {
    container.toggleClass("is-hidden", true);
    return;
  }
  container.toggleClass("is-hidden", false);
  const n = neighborhood(app, file);
  const total = n.backlinks.length + n.outgoing.length + n.related.length;

  const head = container.createDiv({ cls: "mva-nb-head" });
  setIcon(head.createSpan({ cls: "mva-nb-chevron" }), "chevron-right");
  setIcon(head.createSpan({ cls: "mva-nb-icon" }), "network");
  head.createSpan({ cls: "mva-nb-title", text: basename(file.path) });
  head.createSpan({ cls: "mva-nb-count", text: String(total) });
  head.onclick = () => container.toggleClass("is-collapsed", !container.hasClass("is-collapsed"));
  container.toggleClass("is-collapsed", true);

  const body = container.createDiv({ cls: "mva-nb-body" });
  const section = (label: string, paths: string[]) => {
    if (!paths.length) return;
    const sec = body.createDiv({ cls: "mva-nb-section" });
    sec.createDiv({ cls: "mva-nb-label", text: label });
    for (const p of paths.slice(0, 12)) {
      const chip = sec.createSpan({ cls: "mva-nb-chip", text: basename(p) });
      chip.onclick = () => onOpen(p);
    }
  };
  section("Related", n.related);
  section("Backlinks", n.backlinks);
  section("Links out", n.outgoing);
  if (total === 0) body.createDiv({ cls: "mva-faint", text: "No connections yet." });
}

export interface TouchedNote {
  path: string;
  kind: "read" | "write";
}

/** Render a small radial SVG of the notes the agent touched this turn. */
export function renderMiniGraph(
  parent: HTMLElement,
  touched: TouchedNote[],
  onOpen: (path: string) => void
): void {
  if (touched.length === 0) return;
  const nodes = touched.slice(0, 8);
  const W = 260;
  const H = 120;
  const cx = W / 2;
  const cy = H / 2;
  const r = 42;

  const svg = parent.createSvg("svg", { cls: "mva-graph" });
  svg.setAttr("viewBox", `0 0 ${W} ${H}`);
  svg.setAttr("width", "100%");

  // center "turn" node
  const place = (x: number, y: number, color: string, label: string, path?: string) => {
    if (path) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(cx));
      line.setAttribute("y1", String(cy));
      line.setAttribute("x2", String(x));
      line.setAttribute("y2", String(y));
      line.setAttribute("class", "mva-graph-edge");
      svg.appendChild(line);
    }
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "mva-graph-node");
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", String(y));
    c.setAttribute("r", path ? "5" : "6");
    c.setAttribute("fill", color);
    g.appendChild(c);
    if (path) {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", String(x));
      t.setAttribute("y", String(y + 15));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "mva-graph-label");
      t.textContent = label.length > 14 ? label.slice(0, 13) + "…" : label;
      g.appendChild(t);
      g.addEventListener("click", () => path && onOpen(path));
      g.style.cursor = "pointer";
    }
    svg.appendChild(g);
  };

  place(cx, cy, "var(--text-faint)", "");
  nodes.forEach((node, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * (r * 0.72);
    const color = node.kind === "write" ? "#d97757" : "#5b8def";
    place(x, y, color, basename(node.path), node.path);
  });
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
  const parts = md.split(/(```[\s\S]*?```|`[^`]*`|\[\[[^\]]*\]\])/g);
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
