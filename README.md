# Kortex

An agentic AI assistant in your Obsidian sidebar, powered by the **Claude CLI** or the **Codex CLI**. Your vault is the agent's working directory. Custom-rendered, theme-aware chat UI — no terminal.

## Features

- **Custom chat UI** — streaming markdown, message bubbles, theme-agnostic (built on Obsidian's native CSS variables; transparent panel that adapts to any theme).
- **Two backends, switchable** — Claude (via the Claude Agent SDK pointed at your installed CLI) and Codex (`codex exec --json`). Switch per conversation from the header.
- **Agentic** — the agent can Read / Write / Edit / Bash / Search with the vault as its working directory.
- **Permission gating** (Claude) — tool calls surface as cards; sensitive actions (Edit/Write/unlisted Bash) prompt with **Allow once / Always allow / Deny**, with a per-session allowlist and auto-allow for read-only tools. Codex is gated by its own sandbox (`workspace-write`).
- **Tool-call cards** — running / success / error, with diff preview for edits and command + output for shell.
- **Knowledge-work native** — answers stream with a live caret; assistant replies can be **inserted into the active note** or copied; tool cards link the **note they touched** (click to open it in the graph); a teaching empty state offers vault-aware starters.
- **Persistent sessions** — Claude conversations keep one warm SDK process across turns (streaming-input), so follow-ups skip cold start and context is retained. A footer shows live **context-window usage**.
- **Reasoning** — the model's thinking streams into a collapsible block.
- **Fast startup** — skips global hooks + MCP per turn for snappier responses (toggle in settings).
- **Resilient** — a clear setup card when the CLI isn't signed in; retry any turn.

### Obsidian-native (Claude; all toggleable in settings)

- **Native tools** — an in-process MCP server gives the agent graph- and metadata-aware tools alongside the standard ones: `search_vault`, `read_note`, `get_backlinks`, `get_neighborhood`, `list_notes`, `list_tags`, `get_active_context`, `create_note` (tag/frontmatter aware), `append_to_note`, `update_frontmatter`, `add_links`, `open_note`.
- **Vault memory** — boots each conversation with context from `_system/` (vault-context, preferences, active rules, recent sessions), and can write back via gated tools: `capture_decision`, `log_session`, `capture_learning` (tagged `created_by: kortex`).
- **Graph in the UI** — surface notes related to the active note; a collapsible **neighborhood panel** (backlinks / links out / related); **wikilink-ify** replies (mentions of touched notes become clickable `[[links]]`); a **mini-graph** of the notes each turn read/wrote.
- **Composer power-ups** — `/` opens a palette of custom prompts + your vault's `.claude/` commands and skills; `@` mentions a file or folder to add it as context. Footer selectors for **effort** (low→max) and **permission mode**.
- **Context** — the active note is auto-attached as a removable chip; attach more notes via the "+ Note" picker or `@`.
- **History** — conversations **persist to disk** (survive reload, with session resume). The history button opens a **card gallery** with per-conversation previews (title, snippet, provider, message count, date); click a card to reopen it. Copy any reply.

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
`.obsidian/plugins/kortex` folder to auto-deploy on each build.

## Architecture

- `src/main.ts` — plugin entry (view registration, ribbon, command, settings).
- `src/view.ts` — the chat `ItemView` (header, message list, tool/permission cards, composer, history, context chips).
- `src/providers/` — `ProviderAdapter` interface + `claude.ts` (Agent SDK) and `codex.ts` (CLI) adapters, normalized into a single `AgentEvent` stream.
- `src/cli.ts` — robust CLI path resolution (Obsidian doesn't inherit the shell PATH).
- `src/ui/tools.ts` — tool metadata + detail/diff rendering.

## Status

Phases 1–5 implemented: text streaming, agentic tools + permission gating (Claude), Codex backend with tool cards, theme-aware transparent UI, context chips + multi-note attach, persistent conversation history, copy. Codex tool-event parsing is best-effort (CLI event schema is version-sensitive); per-action Codex approvals (`codex proto`) are not yet wired — Codex relies on its sandbox.

## License

MIT
