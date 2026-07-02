import { App, TFile } from "obsidian";

/**
 * Deterministic (no-LLM) memory-consolidation engine — "dream" pass.
 *
 * The vault's `_system/memory/` layer accumulates raw learnings over time. This
 * engine consolidates that layer with pure string/date/count math (no model
 * calls, fully reproducible):
 *   1. **Dedup** — collapse learnings that share a slug, summing their evidence.
 *   2. **Promote** — turn a learning with enough combined evidence into a rule.
 *   3. **Stale** — flag rules that haven't been updated in a long time.
 *
 * Because this mutates Mario's real memory, every mutating pass records a
 * before-image of each touched file into a {@link DreamSnapshot}, so the entire
 * pass is reversible via {@link undoPlan}. `computePlan` is strictly read-only.
 */

export interface DreamPlan {
  /** Number of learnings scanned. */
  scanned: number;
  /** Dedup groups: `keep` survives, `drop` files are deleted, `evidence` is the summed group evidence. */
  dedup: { keep: string; drop: string[]; evidence: number }[];
  /** Promotions: learning path -> rule path, with the evidence that qualified it. */
  promote: { from: string; to: string; evidence: number }[];
  /** Rules going stale: rule path + its last-updated marker. */
  stale: { path: string; lastUpdated: string }[];
}

export interface DreamSnapshot {
  /** ISO-ish timestamp string, passed in by the caller. */
  ranAt: string;
  /** Before-image per touched file. `before === null` => the pass CREATED it (delete on undo). */
  files: { path: string; before: string | null }[];
}

const LEARNINGS_DIR = "_system/memory/learnings";
const RULES_DIR = "_system/memory/rules";
const PROMOTE_AT = 3; // combined evidence needed to promote learning -> rule
const STALE_DAYS = 120; // rule not updated in this many days -> mark stale

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Local `YYYY-MM-DD` (NOT toISOString — avoids the UTC off-by-one at day boundaries). */
function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Frontmatter of a file as a plain record (empty object if none). */
function fm(app: App, file: TFile): Record<string, unknown> {
  return (app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
}

/** The slug identity of a learning: basename minus a leading `YYYY-MM-DD-`, lowercased. */
function learningKey(basename: string): string {
  return basename.replace(DATE_PREFIX, "").toLowerCase();
}

/** The `YYYY-MM-DD` date prefix of a basename, or "" if absent. */
function dateFromBasename(basename: string): string {
  const m = basename.match(DATE_PREFIX);
  return m ? m[0].slice(0, 10) : "";
}

/** Evidence weight of a file's frontmatter — `evidence`, else `confirmed_sessions`, else 1. */
function evidenceOf(f: Record<string, unknown>): number {
  return Number(f.evidence ?? f.confirmed_sessions ?? 1) || 1;
}

/** Days elapsed since `dateStr` (if a valid YYYY-MM-DD), else since `mtimeMs`. */
function daysSince(dateStr: string, mtimeMs: number): number {
  const t = DATE_ONLY.test(dateStr) ? new Date(dateStr).getTime() : mtimeMs;
  return Math.floor((Date.now() - t) / 86400000);
}

/** Markdown files living directly under a `_system/memory/*` directory. */
function filesIn(app: App, dir: string): TFile[] {
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(dir + "/"));
}

/**
 * READ-ONLY. Compute the consolidation plan without mutating anything.
 * Safe to call for a preview/dry-run.
 */
export function computePlan(app: App): DreamPlan {
  const learnings = filesIn(app, LEARNINGS_DIR);
  const plan: DreamPlan = { scanned: learnings.length, dedup: [], promote: [], stale: [] };

  // Group learnings by slug identity.
  const groups = new Map<string, TFile[]>();
  for (const f of learnings) {
    const key = learningKey(f.basename);
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }

  for (const [key, files] of groups) {
    // Effective evidence for the group: sum across all members (single or deduped).
    const evidence = files.reduce((sum, f) => sum + evidenceOf(fm(app, f)), 0);

    let keep = files[0];
    if (files.length > 1) {
      // keep = latest date prefix; ties broken by latest mtime.
      keep = files.reduce((best, f) => {
        const bd = dateFromBasename(best.basename);
        const fd = dateFromBasename(f.basename);
        if (fd > bd) return f;
        if (fd < bd) return best;
        return f.stat.mtime > best.stat.mtime ? f : best;
      }, files[0]);
      const drop = files.filter((f) => f.path !== keep.path).map((f) => f.path);
      plan.dedup.push({ keep: keep.path, drop, evidence });
    }

    // Promote if the effective evidence clears the bar — but never clobber an existing rule.
    if (evidence >= PROMOTE_AT) {
      const target = `${RULES_DIR}/rule-${key}.md`;
      const existing = app.vault.getAbstractFileByPath(target);
      if (!(existing instanceof TFile)) {
        plan.promote.push({ from: keep.path, to: target, evidence });
      }
    }
  }

  // Stale detection over the rules directory.
  for (const f of filesIn(app, RULES_DIR)) {
    const meta = fm(app, f);
    if (String(meta.status) === "stale") continue;
    const lastUpdated = String(meta.last_updated ?? "");
    if (daysSince(lastUpdated, f.stat.mtime) > STALE_DAYS) {
      plan.stale.push({ path: f.path, lastUpdated: lastUpdated || "(mtime)" });
    }
  }

  return plan;
}

/**
 * Enact a plan, capturing a before-image of every file BEFORE its first
 * mutation so the whole pass is reversible. First record of a path wins, so a
 * file touched twice still restores to its true pre-pass state.
 *
 * Each item is wrapped in try/catch: one failure records what it can and does
 * not abort the rest of the pass.
 */
export async function applyPlan(app: App, plan: DreamPlan, ranAt: string): Promise<DreamSnapshot> {
  const snapshots = new Map<string, string | null>();
  const snap = (path: string, before: string | null): void => {
    if (!snapshots.has(path)) snapshots.set(path, before);
  };
  const asFile = (path: string): TFile | null => {
    const f = app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  };

  // 1) Dedup first: bump the survivor's evidence, delete the duplicates.
  for (const entry of plan.dedup) {
    try {
      const keepFile = asFile(entry.keep);
      if (keepFile) {
        snap(entry.keep, await app.vault.read(keepFile));
        await app.fileManager.processFrontMatter(keepFile, (f) => {
          f.evidence = entry.evidence;
          f.last_confirmed = today();
        });
      }
      for (const dropPath of entry.drop) {
        try {
          const dropFile = asFile(dropPath);
          if (!dropFile) continue;
          snap(dropPath, await app.vault.read(dropFile));
          await app.vault.delete(dropFile);
        } catch {
          /* skip this drop, keep going */
        }
      }
    } catch {
      /* skip this dedup entry */
    }
  }

  // 2) Promote: move the learning into the rules dir, rewrite its frontmatter as a rule.
  for (const entry of plan.promote) {
    try {
      const fromFile = asFile(entry.from);
      if (!fromFile) continue;
      const sourceBasename = fromFile.basename;
      snap(entry.from, await app.vault.read(fromFile));
      snap(entry.to, null); // target is created by the rename
      await app.fileManager.renameFile(fromFile, entry.to);
      const movedFile = asFile(entry.to);
      if (movedFile) {
        await app.fileManager.processFrontMatter(movedFile, (f) => {
          f.rule = learningKey(sourceBasename);
          f.confirmed_sessions = entry.evidence;
          f.last_updated = today();
          f.status = "confirmed";
          delete f.evidence;
          delete f.last_confirmed;
        });
      }
    } catch {
      /* skip this promote entry */
    }
  }

  // 3) Stale: flag rules that have gone cold.
  for (const entry of plan.stale) {
    try {
      const file = asFile(entry.path);
      if (!file) continue;
      snap(entry.path, await app.vault.read(file));
      await app.fileManager.processFrontMatter(file, (f) => {
        f.status = "stale";
      });
    } catch {
      /* skip this stale entry */
    }
  }

  return {
    ranAt,
    files: [...snapshots.entries()].map(([path, before]) => ({ path, before })),
  };
}

/**
 * Restore every snapshotted file to its pre-pass state. Returns how many files
 * were restored.
 *
 * - `before === null` => the pass created the file; delete it if it exists.
 * - otherwise => rewrite (or recreate) the file with its before-image.
 *
 * Each item is guarded; failures are skipped so a partial undo still restores
 * as much as possible.
 */
export async function undoPlan(app: App, snap: DreamSnapshot): Promise<number> {
  let count = 0;
  for (const { path, before } of snap.files) {
    try {
      const existing = app.vault.getAbstractFileByPath(path);
      if (before === null) {
        // File was created by the pass — remove it.
        if (existing instanceof TFile) {
          await app.vault.delete(existing);
          count++;
        }
        continue;
      }
      if (existing instanceof TFile) {
        await app.vault.modify(existing, before);
      } else {
        // File was deleted/moved by the pass — recreate it, parent folder first.
        const slash = path.lastIndexOf("/");
        if (slash > 0) {
          const dir = path.slice(0, slash);
          if (!app.vault.getAbstractFileByPath(dir)) {
            try {
              await app.vault.createFolder(dir);
            } catch {
              /* folder may already exist / race — ignore */
            }
          }
        }
        await app.vault.create(path, before);
      }
      count++;
    } catch {
      /* skip this restore, keep going */
    }
  }
  return count;
}
