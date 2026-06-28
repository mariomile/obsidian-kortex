# Marioverse Agent

An agentic AI assistant in your Obsidian sidebar, powered by the **Claude CLI** or the **Codex CLI**. Your vault is the agent's working directory. Custom-rendered, theme-aware chat UI — no terminal.

## Features

- **Custom chat UI** — streaming markdown, message bubbles, theme-agnostic (built on Obsidian's native CSS variables; transparent panel that adapts to any theme).
- **Two backends, switchable** — Claude (via the Claude Agent SDK pointed at your installed CLI) and Codex (`codex exec --json`). Switch per conversation from the header.
- **Agentic** — the agent can Read / Write / Edit / Bash / Search with the vault as its working directory.
- **Permission gating** (Claude) — tool calls surface as cards; sensitive actions (Edit/Write/unlisted Bash) prompt with **Allow once / Always allow / Deny**, with a per-session allowlist and auto-allow for read-only tools. Codex is gated by its own sandbox (`workspace-write`).
- **Tool-call cards** — running / success / error, with diff preview for edits and command + output for shell.
- **Context** — the active note is auto-attached as a removable chip.
- **History** — switch between conversations in the session; copy any reply.

## Requirements

- Desktop Obsidian (uses Node child processes — `isDesktopOnly`).
- The `claude` and/or `codex` CLI installed and logged in. Paths auto-detect; override in settings if needed.

## Develop

```bash
npm install
npm run dev      # watch + auto-deploy (see .obsidian-plugin-dir)
npm run build    # typecheck + production bundle
```

Create a `.obsidian-plugin-dir` file containing the absolute path to your vault's
`.obsidian/plugins/marioverse-agent` folder to auto-deploy on each build.

## Architecture

- `src/main.ts` — plugin entry (view registration, ribbon, command, settings).
- `src/view.ts` — the chat `ItemView` (header, message list, tool/permission cards, composer, history, context chips).
- `src/providers/` — `ProviderAdapter` interface + `claude.ts` (Agent SDK) and `codex.ts` (CLI) adapters, normalized into a single `AgentEvent` stream.
- `src/cli.ts` — robust CLI path resolution (Obsidian doesn't inherit the shell PATH).
- `src/ui/tools.ts` — tool metadata + detail/diff rendering.

## Status

Phases 1–4 implemented: text streaming, agentic tools + permission gating (Claude), Codex backend with tool cards, theme-aware transparent UI, context chips, history, copy. Codex tool-event parsing is best-effort (CLI event schema is version-sensitive).

## License

MIT
