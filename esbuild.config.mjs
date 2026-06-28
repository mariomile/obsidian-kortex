import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { existsSync, readFileSync, copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const prod = process.argv[2] === "production";

// Live-deploy target: a `.obsidian-plugin-dir` file (gitignored) containing the
// absolute path to `.obsidian/plugins/marioverse-agent`. Mirrors the convention
// used in obsidian-selection-toolbar.
const deployDir = existsSync(".obsidian-plugin-dir")
  ? readFileSync(".obsidian-plugin-dir", "utf8").trim()
  : process.env.OBSIDIAN_PLUGIN_DIR || null;

const deployPlugin = {
  name: "deploy",
  setup(build) {
    build.onEnd(() => {
      if (!deployDir) return;
      try {
        mkdirSync(deployDir, { recursive: true });
        for (const f of ["main.js", "manifest.json", "styles.css"]) {
          if (existsSync(f)) copyFileSync(f, join(deployDir, f));
        }
        console.log(`[deploy] copied to ${deployDir}`);
      } catch (e) {
        console.warn(`[deploy] failed: ${e?.message ?? e}`);
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
    // The Claude Agent SDK imports builtins with the `node:` prefix.
    ...builtins.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2021",
  // The Claude Agent SDK calls createRequire(import.meta.url); in a CJS bundle
  // that token would be undefined and throw at load. Map it to a runtime file
  // URL derived from __filename (always present in CJS / Electron).
  define: { "import.meta.url": "__mvaImportMetaUrl" },
  banner: {
    js: "const __mvaImportMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [deployPlugin],
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
