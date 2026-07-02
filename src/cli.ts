import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";
import { dirname } from "path";

/** A resolved CLI invocation: the binary plus an enriched PATH for the spawn. */
export interface ResolvedCli {
  bin: string;
  pathEnv: string;
}

/**
 * Resolve a CLI binary (`claude` or `codex`) + a usable PATH.
 *
 * GUI apps (Obsidian) don't inherit the shell PATH, and tools like nvm only
 * export PATH from `.zshrc` (interactive shells). So we (1) honor an explicit
 * setting, (2) probe the filesystem directly — no shell needed, most reliable —
 * then (3) fall back to an *interactive* login-shell lookup, and finally (4) the
 * bare command name.
 *
 * Adapted from obsidian-selection-toolbar/src/ai/client.ts, generalized for any
 * binary name.
 */
const cliCache = new Map<string, ResolvedCli>();

export async function resolveCli(name: string, configured: string): Promise<ResolvedCli> {
  if (!/^[a-z]+$/.test(name)) throw new Error(`Invalid CLI name: ${name}`);
  const key = `${name} ${configured.trim()}`;
  const cached = cliCache.get(key);
  if (cached) return cached;
  const bin =
    (configured && configured.trim()) ||
    probeFilesystem(name) ||
    (await probeLoginShell(name)) ||
    name;
  const resolved = { bin, pathEnv: buildPathEnv(bin) };
  cliCache.set(key, resolved);
  return resolved;
}

function probeFilesystem(name: string): string | null {
  const home = homedir();
  const fixed = [
    `${home}/.${name}/local/${name}`, // e.g. ~/.claude/local/claude
    `${home}/.local/bin/${name}`,
    `${home}/.local/node/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const c of fixed) {
    if (safeExists(c)) return c;
  }
  // nvm: newest version dir that ships the binary.
  try {
    const nvmRoot = `${home}/.nvm/versions/node`;
    const versions = readdirSync(nvmRoot).sort().reverse();
    for (const v of versions) {
      const p = `${nvmRoot}/${v}/bin/${name}`;
      if (safeExists(p)) return p;
    }
  } catch {
    /* no nvm */
  }
  return null;
}

function probeLoginShell(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      // `-i` so the shell sources .zshrc (where nvm/path setup usually lives).
      const c = spawn(shell, ["-ilc", `command -v ${name}`], { env: process.env });
      let out = "";
      const done = (val: string | null) => resolve(val);
      c.stdout.on("data", (d: Buffer | string) => (out += d.toString()));
      c.on("error", () => done(null));
      c.on("close", () => {
        const lines = out
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const l of lines.reverse()) {
          if (l.startsWith("/") && safeExists(l)) return done(l);
        }
        done(null);
      });
      // Safety: interactive rc files can stall — give up after 6s.
      setTimeout(() => {
        try {
          c.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done(null);
      }, 6000);
    } catch {
      resolve(null);
    }
  });
}

function buildPathEnv(bin: string): string {
  const home = homedir();
  const dirs = [
    bin.includes("/") ? dirname(bin) : "",
    `${home}/.local/bin`,
    `${home}/.local/node/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ];
  return dirs.filter(Boolean).join(":");
}

function safeExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/* ------------------------------ errors -------------------------------- */

export function makeAbortError(): Error {
  const e = new Error("Aborted");
  e.name = "AbortError";
  return e;
}

/** True when the error is our own abort (cancel / restart). */
export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Map a spawn/CLI error to a short, user-facing message. */
export function describeError(e: unknown, cliName = "CLI"): string {
  if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT") {
    return `${cliName} not found. Run \`which ${cliName.toLowerCase()}\` in a terminal and paste the path in Exo settings.`;
  }
  if (e instanceof Error) {
    const msg = e.message || "";
    if (/not logged in|unauthorized|authentication/i.test(msg)) {
      return `${cliName} is not logged in — run it once in a terminal to sign in.`;
    }
    return msg || `${cliName} error.`;
  }
  return "Unknown error.";
}
