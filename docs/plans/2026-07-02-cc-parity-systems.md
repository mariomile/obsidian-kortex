# Claude Code parity systems — Implementation Plan

> **For agentic workers:** execute feature-by-feature IN ORDER. No unit-test harness in this repo: the verification step for every feature is `npm run typecheck` + `npm run build` (both must exit 0), then commit. Live validation happens after all features land (done by the orchestrator, not you). Commit after each feature with the message given.

**Goal:** Close the four real parity gaps between Exo and Claude Code — hooks, persistent permission rules, background-task surfacing, subagent surfacing — plus error-detail surfacing (the `error_during_execution` trigger is currently opaque).

**Architecture:** All five are *exposure* work, not reconstruction: the Claude CLI already implements the mechanics; Exo either disables them (hooks), forgets them (permission choices), or renders them flat (background/subagent tool calls). Changes concentrate in `src/providers/claude.ts` (options + event plumbing), `src/providers/types.ts` (event fields), `src/view.ts` (routing + cards), `src/settings.ts` (new settings + UI), `src/ui/capabilities.ts` (hooks card), `styles.css`.

**Ordering rationale:** 1→2 touch options/permission path; 3→4 touch the tool-card pipeline; 5 is provider-internal. Later features build on earlier plumbing (4 uses the `parentId` field added in 3's neighborhood — add it once).

---

## Feature 1: Hooks (decouple from Fast startup + surface them)

**Files:** `src/settings.ts`, `src/providers/claude.ts`, `src/providers/types.ts` (SessionOpts), `src/view.ts` (ensureSession opts + sessionSig), `src/ui/capabilities.ts`.

Current state: `claude.ts` ~L96 — `...(opts.fastStartup ? { disableAllHooks: true, strictMcpConfig: true, ... } : {})`. Hooks die whenever Fast startup is on (the default), silently.

1. **Setting.** Add `runHooks: boolean` to `MVASettings`, default `true` (CC parity — CC runs hooks by default). Settings UI: toggle "Run Claude Code hooks" with desc "Execute hooks configured in .claude/settings.json (vault and global) — PreToolUse guards, formatters, notifications. Matches Claude Code behavior. Turn off for a slightly faster cold start." Place it next to the Fast startup toggle. Update the Fast startup toggle's description to no longer imply hooks (it now only skips external MCP): "Skips external MCP servers for snappier responses."
2. **Wire it.** In `claude.ts`, split the fast-startup bundle: `disableAllHooks` is now controlled ONLY by `runHooks` (`...(opts.runHooks ? {} : { disableAllHooks: true })`), while `strictMcpConfig` + `mcpServers: {}` stay under `fastStartup`. Add `runHooks?: boolean` to the session opts type (types.ts `SessionOpts` or wherever `fastStartup` is declared — mirror it). In `view.ts` `ensureSession`, pass `runHooks: s.runHooks` and include it in `sessionSigOf(...)` so toggling it rebuilds the session.
3. **Surface them.** In `src/ui/capabilities.ts`, add a "Hooks" card in the Skills/system tier (follow the existing `tier()`/card pattern): read `<vault>/.claude/settings.json` and `~/.claude/settings.json` (Node `fs`/`os` — desktop-only plugin, and capabilities already reads vault files; wrap each read in try/catch, tolerate missing/invalid JSON), collect the keys of their `hooks` objects (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`) with matcher counts, and render e.g. "PreToolUse ×2 · SessionStart ×1 (vault) / Notification ×1 (global)". Empty state: "No hooks configured. Hooks in .claude/settings.json run automatically (PreToolUse guards, formatters, notifications)." If `runHooks` is off, show a muted "Disabled in settings" badge on the card.
4. `npm run typecheck && npm run build` → commit: `feat(parity): run Claude Code hooks (decoupled from Fast startup) + hooks card`

## Feature 2: Persistent permission rules

**Files:** `src/settings.ts`, `src/view.ts` (permission-request handler ~L2573 + `addPermissionCard` ~L2205).

Current state: "Always allow" writes to `c.allow` (per-conversation Set keyed by `allowKey(tool, input)`) — forgotten on reload. No deny rules.

1. **Settings model.** Add to `MVASettings`: `permAllowRules: string` (default `""`), `permDenyRules: string` (default `""`), `rememberAlwaysAllow: boolean` (default `false`). Rules are one per line: `Tool` (exact tool name) or `Tool(prefix)` (tool + argument-prefix; `*` suffix optional/ignored — prefix semantics). Blank lines and `#` comments ignored.
2. **Rule matcher.** In `view.ts`, add a small pure helper:
```ts
/** One rule per line: `Tool` or `Tool(argPrefix)`. `#` comments allowed. */
function matchPermRule(rules: string, tool: string, argText: string): boolean {
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([\w-]+(?:__[\w-]+)*)(?:\((.*?)\))?$/);
    if (!m || m[1] !== tool) continue;
    const prefix = (m[2] ?? "").replace(/\*+$/, "");
    if (!prefix || argText.startsWith(prefix)) return true;
  }
  return false;
}
```
Derive `argText` the same way `allowKey` derives its argument part (reuse/extract that logic so card-created rules and hand-written rules agree — read `allowKey` first and share the extraction).
3. **Enforcement.** In the `permission-request` handler (view.ts ~L2588), extend the decision ladder — deny wins over allow, both before carding:
```ts
const argText = /* shared extraction */;
if (matchPermRule(s.permDenyRules, e.tool, argText)) {
  e.resolve({ behavior: "deny", message: "Denied by an Exo permission rule (settings)." });
} else if ((s.autoAllowRead && isRead) || c.allow.has(this.allowKey(e.tool, e.input)) || matchPermRule(s.permAllowRules, e.tool, argText)) {
  allow({ behavior: "allow" });
} ...
```
Keep the memory-tools deny branch where it is (before the card, after deny rules).
4. **Durable "Always allow".** In `addPermissionCard`, when the user picks "Always allow" and `s.rememberAlwaysAllow` is true, ALSO append the equivalent rule line (`Tool` or `Tool(argPrefix)`) to `s.permAllowRules` (skip if an identical line exists) and `void this.plugin.saveSettings()`.
5. **Settings UI.** New "Permissions" section: toggle "Remember 'Always allow' across sessions"; two textareas "Always-allow rules" / "Deny rules" (monospace, placeholder `Bash(git status)\nread_note`), with desc "One per line: ToolName or ToolName(argument prefix). Deny wins. These apply before the permission card."
6. `npm run typecheck && npm run build` → commit: `feat(parity): persistent permission rules (allow/deny + durable Always-allow)`

## Feature 3: Background task surfacing

**Files:** `src/providers/types.ts`, `src/view.ts` (tool-call-start ~L2532 / tool-call-result), `styles.css`.

Current state: `Bash{run_in_background:true}` / `BashOutput` / `KillShell` render as generic cards; nothing links them.

1. **Detect + badge.** In the `tool-call-start` handler, when `e.name === "Bash"` and `(e.input as any)?.run_in_background === true`, add class `mva-tool-bg` to the card and a small badge chip "background" next to the tool label (reuse chip styling). Track `ctx.bgTasks: Map<string, {cardEl: HTMLElement; shellId?: string}>` keyed by tool-call id.
2. **Link the lifecycle.** On `tool-call-result` for that id, parse the output for the shell id (the CLI result contains it — extract with a tolerant regex like `/shell(?:Id)?[:\s]+([\w-]+)/i` or fall back to storing the raw output); store `shellId`. When a later `tool-call-start` is `BashOutput`/`KillShell` and its input's shell id matches a tracked task, badge THAT card "↳ background task" and update the original card's badge: `BashOutput` → keep "running", `KillShell` → "stopped". This is presentational linking only — no polling, no injected tool calls (Exo cannot call tools itself; only the agent can).
3. **Running strip.** While `ctx.bgTasks` has entries whose status is running, show a slim line under the composer of that conversation: "⏳ N background task(s) running" (clear it at turn end — background shells may outlive the turn, so on `turn-end` change it to "N background task(s) started this turn" faint text inside the turn footer instead of a persistent global strip; keep it simple and honest).
4. CSS: `.mva-tool-bg` accent border-tint + `.mva-badge-bg` chip.
5. `npm run typecheck && npm run build` → commit: `feat(parity): surface background Bash tasks (badges + lifecycle linking)`

## Feature 4: Subagent surfacing (nested Task activity)

**Files:** `src/providers/claude.ts` (`route()` ~L164), `src/providers/types.ts`, `src/view.ts`, `styles.css`.

Current state: `route()` ignores `msg.parent_tool_use_id`, so a subagent's tool_use/tool_result blocks (forwarded by default by the SDK) render as flat top-level cards indistinguishable from the parent's. Do NOT set `forwardSubagentText` (default off is right — tool activity is the signal; full nested transcripts are noise/tokens).

1. **Plumb parentId.** In `types.ts`, add optional `parentId?: string` to the `tool-call-start` and `tool-call-result` event variants. In `claude.ts` `route()`, read `const pid = (msg as any).parent_tool_use_id ?? undefined;` on the `assistant` and `user` branches and pass `parentId: pid` through both emits.
2. **Nest in the view.** In `tool-call-start`: if `e.parentId` is set, do NOT create a top-level card. Instead find the parent Task card (track `ctx.taskCards: Map<string, HTMLElement>` — populate it in the normal tool-call-start path when `e.name === "Task"`, mapping the Task's tool-call id → a nested container el created inside that card, collapsed by default with a clickable summary row "Subagent activity (N)"). Append a mini-row: status dot + tool name + one-line arg summary (reuse the existing card-label/`toolFilePath` helpers for the arg text). Keep a `ctx.nestedRows: Map<string,{rowEl,parent}>` for results. If the parent Task card isn't found (edge: parentId for an unknown id), fall back to the current flat card so nothing is lost.
3. **Results + counter.** On `tool-call-result` with `parentId`: mark the mini-row ok/error (dot color), and bump the "Subagent activity (N)" counter text. On the TASK's own tool-call-result, mark the section complete (e.g. "Subagent activity (N) — done").
4. **Persistence:** mini-rows are ephemeral (live-turn only) — do NOT add them to `ctx.segments`; the Task card itself already persists as a tool segment. (Honest scope: nested detail is a live-progress affordance; the transcript keeps the summary.)
5. CSS: `.mva-subagent` container (indent + left hairline), `.mva-subagent-row` (small, muted), status dots reuse existing ok/err colors.
6. `npm run typecheck && npm run build` → commit: `feat(parity): nest subagent tool activity under Task cards`

## Feature 5: Error-detail surfacing (stderr ring buffer)

**Files:** `src/providers/claude.ts` only.

Current state: on a `result` with error subtype, Exo emits `msg.result || "Claude ended: <subtype>"` — `msg.result` is empty on `error_during_execution`, so the user (and we, debugging) get zero detail. The SDK exposes `stderr?: (data: string) => void` (sdk.d.ts ~L1876).

1. **Ring buffer.** Add to the session class: `private stderrTail: string[] = [];` In the `query()` options, add:
```ts
stderr: (data: string) => {
  for (const line of data.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    this.stderrTail.push(t.length > 400 ? t.slice(0, 400) + "…" : t);
    if (this.stderrTail.length > 12) this.stderrTail.shift();
  }
},
```
2. **Attach on error.** In the `result` branch (~L183), when `msg.subtype && msg.subtype !== "success"`, build the message as: `msg.result || "Claude ended: " + msg.subtype`, and if `this.stderrTail.length`, append `"\n\nCLI stderr (tail):\n" + this.stderrTail.slice(-6).join("\n")`. Clear `this.stderrTail = []` at the start of each `send()` so the tail is per-turn.
3. `npm run typecheck && npm run build` → commit: `feat(reliability): surface CLI stderr tail on execution errors`

---

## Self-review notes
- All five map to the agreed parity roadmap + the 0.3.1 follow-up. No new subsystems invented.
- Shared plumbing: `parentId` added once (F4); F3 and F4 both touch tool-call handlers — F3 lands first, F4 must not regress the bg badges (nested bg tool calls: badge inside the mini-row is out of scope, skip).
- Honest limits stated in-plan: background linking is presentational (no polling); subagent rows are live-only; hooks card is read-only surfacing.
- Settings additions: `runHooks`, `permAllowRules`, `permDenyRules`, `rememberAlwaysAllow` — all with defaults, no migration needed (spread-with-defaults load pattern already in main.ts).
