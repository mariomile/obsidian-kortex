# Ask User tool — design (v1, full parity)

**Status:** approved (2026-07-02) · **Scope:** Claude-only, in-process MCP tool

## Goal

Give the Exo agent a first-class way to ask the user structured questions with
selectable options — the same interaction pattern as Claude Code's
`AskUserQuestion` — rendered as a card in the chat. The agent gets clean,
unambiguous input instead of parsing free-form replies, and the user answers by
clicking instead of typing.

**Non-goal (v1):** Codex support (no in-process MCP), and any persistence of
answers beyond the normal transcript.

## Context / prior art in the codebase

The mechanism already exists in a sibling form: the **permission card**. Its shape
is _tool handler emits an event with a `resolve` callback → the view renders a
card with buttons → a click calls `resolve` → the SDK unblocks_. Ask User is the
same promise-resolve bridge with different content. Reusing it is the whole point:
minimal new surface, maximum reuse of collaudated infrastructure.

Relevant existing pieces:
- `src/obsidian/tools.ts` — `createObsidianToolServer(app, alwaysLoad, memoryWrite)` builds the in-process MCP server; `OBSIDIAN_READ_TOOLS` set.
- `src/providers/claude.ts` — `canUseTool` → emits `permission-request` events with a `resolve`; the pump routes SDK messages.
- `src/view.ts` — `runTurn` handles `onEvent`; `addPermissionCard` renders the card; `c.pendingPerm` cancels an open card on Stop; the IDLE_TIMEOUT (120s) watchdog; `AssistantCtx` per-turn state.
- `src/providers/types.ts` — `AgentEvent` union.

## Architecture

Four pieces:

### 1. The `ask_user` tool (in `src/obsidian/tools.ts`)
A new tool registered on the in-process MCP server. Schema mirrors Claude Code's:

```
ask_user({
  questions: [{                    // 1..4 questions
    question: string,
    header: string,                // short chip label
    options: [{ label, description }],  // 2..6 options
    multiSelect?: boolean,
  }]
})
```

- The tool is **auto-allowed** (no permission card): it _is_ a user interaction and
  has no side effects. It must NOT be added to `OBSIDIAN_READ_TOOLS` (that's for the
  auto-allow-read path); instead the view treats `mcp__obsidian__ask_user`
  specially: never gate it, always run the ask bridge.
- Description instructs the model to prefer it for structured choices.
- To stop the model from calling the SDK's built-in `AskUserQuestion` (which has no
  UI in this embedding), add it to `disallowedTools` in `claude.ts` whenever the
  Obsidian server is active.

The handler cannot render UI itself. It calls an **`askBridge`** function passed
into `createObsidianToolServer(...)` and awaits its promise:

```
askBridge: (questions) => Promise<Record<string, string>>   // header -> chosen answer(s)
```

The factory signature gains an optional `askBridge` param (like `memoryWrite`). The
handler returns the answers object stringified as the tool result.

### 2. The bridge (view → tool)
`ChatView` supplies `askBridge` when it builds the server. The bridge:
- Resolves the **target conversation/turn**: when `onEvent` sees the
  `tool-call-start` for `ask_user`, it records the active `AssistantCtx`; the bridge
  renders the card in that turn (fallback: the active conversation's current turn).
- Returns a promise that resolves when the user submits.

This is the exact promise-resolve shape of `addPermissionCard`, generalized.

### 3. The `AskCard` UI (in `src/view.ts`, styles in `styles.css`)
Same visual family as the permission card. For each question:
- header chip + question text,
- options as **buttons** (label emphasized, description under it),
- `multiSelect` → the options become toggles + a "Confirm" button,
- always a trailing **"Other…"** affordance: a text input for a free-form answer.

Behavior:
- Single question + single-select → clicking an option resolves immediately.
- Multi-question or any multi-select → answer all, then one submit resolves.
- The resolved card stays in the transcript, collapsed, showing the chosen
  answer(s). It persists as a new **`{ t: "ask" }` segment variant** (alongside the
  existing `text`/`tool` variants), rebuilt read-only on restore like tool cards.
- Answer payload to the agent: `{ [header]: answer }` (comma-joined for multi).

### 4. Persistence
The ask card is stored as the new `{ t: "ask" }` `Segment` variant (with the
questions + chosen answers) so it survives reload and shows the answers when the
conversation is re-rendered. No separate store; it rides the existing
`serialize()`/`renderConvoDom` path like `text`/`tool` segments.

## Data flow

```
agent calls ask_user(questions)
  → tool handler: await askBridge(questions)
    → view: render AskCard in the target turn; watchdog suspended
      → user selects / types Other / submits
    → resolve(answers)
  → handler returns JSON(answers) as tool result
  → agent continues with the answers
```

## Error handling (the three cases that matter)

1. **Idle watchdog vs. thinking time.** Today the 120s IDLE_TIMEOUT would fire while
   the user is deciding — a latent bug that already affects permission cards. Fix
   (included in this work): **suspend the watchdog while an interactive card (ask or
   permission) is pending**, resume on answer. Implement by clearing/not-arming the
   watchdog when a card opens and re-arming (`bump()`) on resolve.
2. **Stop with a card open.** The Stop button must cancel a pending ask card and
   resolve the tool with a "cancelled by user" result, so the SDK unwinds and the
   turn ends cleanly. Extend the existing `c.pendingPerm` cancel hook to also cover a
   pending ask (a `c.pendingAsk` or a shared "pending interactive" cancel).
3. **Headless / no user present.** In scheduled headless runs there is no view, so no
   `askBridge`. When `askBridge` is absent, the tool resolves with a graceful message
   ("No user is present — proceed with your best judgment.") so the agent continues
   autonomously instead of hanging.

## Scope (v1, honest)

- Full parity with Claude Code's AskUserQuestion: 1–4 questions/call, multi-select,
  free-form "Other". Claude-only.
- Not in v1: images/previews in options, per-option preview panes, answer analytics.

## Verification

No test harness in the repo; use the same manual protocol that has caught the real
bugs this session. Typecheck + build at each step, then live validation in Obsidian:
- a prompt that pushes the agent to call `ask_user` — single-select (resolves on
  click), multi-select (toggle + confirm), multi-question (answer all + submit), and
  the "Other…" free-form path,
- press Stop with a card open → verify the turn ends cleanly and the tool is
  cancelled,
- reload the vault → verify the resolved ask card persists in the transcript with
  the chosen answers,
- confirm the watchdog no longer times out while a card is pending (open a card,
  wait > 120s, then answer).

## Files touched

- `src/obsidian/tools.ts` — the `ask_user` tool + `askBridge` param.
- `src/view.ts` — the `askBridge` impl, `AskCard`, watchdog suspension, Stop hook,
  ask segment persistence.
- `src/providers/claude.ts` — `disallowedTools += AskUserQuestion` when the obsidian
  server is active.
- `styles.css` — the ask card styles (reuse `.mva-perm*` / `.mva-btn*` where possible).
- `src/providers/types.ts` — only if a new event/segment type is cleaner than reusing.
