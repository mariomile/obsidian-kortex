# Marketplace submission readiness — Exo

Status: **preparation only**. Nothing has been submitted, released, or tagged as part of this pass. This document is the reference Mario uses when he manually submits later.

Verified against the official docs on 2026-07-03:
- https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin
- https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins
- https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- https://docs.obsidian.md/Developer+policies
- https://docs.obsidian.md/Reference/Manifest
- https://github.com/obsidianmd/obsidian-releases (README + `community-plugins.json` + `.github/workflows/mirror-community-json.yml`)

## Important — the submission mechanism has changed

The brief assumed the classic flow: hand-edit `community-plugins.json` in `obsidianmd/obsidian-releases` and open a PR. **That is no longer the current path.** As of this verification:

- `docs.obsidian.md/Plugins/Releasing/Submit+your+plugin` describes submission as happening through a **web portal at community.obsidian.md**: sign in → link your GitHub account → **Plugins → New plugin** → enter your repo URL → agree to the Developer policies → submit.
- The `obsidianmd/obsidian-releases` README no longer documents manual-PR instructions for adding entries to `community-plugins.json` — it just links to the same "Submit your plugin" doc.
- `community-plugins.json`'s git history is now a stream of automated `chore: Mirror community plugins and themes` commits (see `.github/workflows/mirror-community-json.yml` in that repo) with no human authors — i.e. the file is a **generated mirror** of whatever the portal's backend has approved, not a file the community edits by hand anymore.

**Practical conclusion:** Mario should submit via the **community.obsidian.md portal**, not a hand-authored PR. The JSON snippet and PR text below are still included per the brief (Task 3 asks for them explicitly) — the JSON entry documents what will eventually appear in `community-plugins.json` once approved, and the PR text is kept as a fallback/reference in case a manual PR is ever needed or useful as a paper trail — but treat the portal flow as the real, current, primary path.

## 1. Pre-submission checklist

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | Repo is public on GitHub | **PASS** | `github.com/mariomile/obsidian-exo`, `isPrivate: false` |
| 2 | `README.md` describes purpose + usage | **PASS** | Existing README covers features/install/architecture; this pass added the Privacy & Security section |
| 3 | `LICENSE` present | **PASS** | MIT, `Copyright (c) 2026 Mario Miletta` |
| 4 | `manifest.json` present and complete | **PASS** (fixed) | Was missing `authorUrl` — added `"authorUrl": "https://github.com/mariomile"` this pass |
| 5 | `manifest.json` → `id`: lowercase letters/hyphens only, no "obsidian", doesn't end in "plugin" | **PASS** | `"exo"` — no violations |
| 6 | `manifest.json` → `id` unique across the community directory | **PASS** | Checked live `community-plugins.json` (5,311 entries) — no `id: "exo"`, no `mariomile` repo present |
| 7 | `manifest.json` → `version` is semver `x.y.z` | **PASS** | `0.8.1` |
| 8 | `manifest.json` → `version` matches `package.json` `version` | **PASS** | Both `0.8.1` |
| 9 | `manifest.json` → `minAppVersion` set | **PASS** | `1.7.2` |
| 10 | `manifest.json` → `description`: concise, ends with a period, ≤250 chars, no emoji, doesn't open with "This is a plugin…" | **PASS** | 156 chars, ends with `.`, no emoji, opens with "An agentic AI assistant…" (not the banned "This is a plugin" phrasing). Not phrased as an imperative verb ("Translate…", "Generate…") per the style guideline's example pattern — a soft style nit, not a hard blocker; left as-is since it already reads as a proper, non-redundant sentence |
| 11 | `manifest.json` → `author` set | **PASS** | `"Mario Miletta"` |
| 12 | `manifest.json` → `authorUrl` (optional) | **PASS** (fixed) | Added, points to `https://github.com/mariomile` |
| 13 | `manifest.json` → `fundingUrl` (optional) | **N/A** | Correctly omitted — Mario doesn't accept donations for this plugin; guideline says to omit if not applicable |
| 14 | `manifest.json` → `isDesktopOnly: true` if using Node/Electron APIs | **PASS** | `true`, correctly set — plugin uses `child_process` (`src/cli.ts`) |
| 15 | `versions.json` present, keys ⊆ manifest history, values are valid Obsidian versions | **PASS** | 12 entries, `0.1.0`→`0.8.1`, all mapped to `1.7.2`, includes current manifest version |
| 16 | GitHub release exists with tag **exactly** matching `manifest.json` version, **no leading `v`** | **PASS** | Release `0.8.1` exists, tag `0.8.1` |
| 17 | Release has `main.js` and `manifest.json` attached (required); `styles.css` attached (optional but present) | **PASS** | Verified via `gh release view 0.8.1 --json assets` → `main.js`, `manifest.json`, `styles.css` all attached |
| 18 | `.github/workflows/release.yml` verifies manifest version == tag before releasing | **PASS** (pre-existing) | Already enforced in this repo's release workflow |
| 19 | Network-use disclosure in README (what remote services, why) | **PASS** (fixed) | Added: Exo makes no network calls itself; discloses that `claude`/`codex` CLIs call Anthropic/OpenAI using the user's own credentials |
| 20 | Server-side telemetry disclosure + privacy-policy link, if applicable | **N/A** | Exo collects and transmits nothing itself — no telemetry to disclose beyond what's now stated (no data collected) |
| 21 | Client-side telemetry — must not be present | **PASS** | Not present, and README now says so explicitly |
| 22 | "Accessing files outside the vault" disclosure, if applicable | **N/A** | Exo's CLI child processes operate with the vault as their working directory; no access outside the vault is performed by the plugin |
| 23 | No dynamic ads / static ads outside own UI / no auto-update mechanism / no obfuscated code | **PASS** | None of these apply to this codebase |
| 24 | Sample/scaffold code removed | **PASS** | Repo is a mature, purpose-built codebase (no `main.ts` sample boilerplate left over) |
| 25 | Command IDs don't duplicate the plugin ID prefix | **PASS** | Verified 2026-07-03 via `grep -n "addCommand" src/main.ts` — all 11 command ids: `open-chat`, `new-tab`, `new-session`, `close-tab`, `fork-conversation`, `compact`, `toggle-plan`, `inline-edit`, `memory-dream-pass`, `memory-dream-undo`, `run-playbook`. None start with `exo-` or `exo:` (Obsidian already namespaces them as `exo:<id>` at runtime, so a manual `exo-`/`exo:` prefix in source would double up) |
| 26 | Submit via **community.obsidian.md** portal (current process) | **OPEN — manual step** | Requires Mario to sign in, link GitHub, and submit `github.com/mariomile/obsidian-exo` through the portal himself. Cannot be done from this environment. |
| 27 | (Legacy/fallback) PR to `obsidianmd/obsidian-releases` adding a `community-plugins.json` entry | **OPEN — manual step, likely unnecessary** | See "Important" section above — kept as reference text below in case Mario wants a fallback/paper-trail PR, but the portal is the real path |

### Remaining open items (manual, outside this environment)
- Submit the plugin via the community.obsidian.md portal (item 26).
- Optional: cut a fresh `0.8.2`+ release once the `authorUrl` addition (and any other changes from this pass) should ship to users installing via BRAT/manual download — the current `0.8.1` release predates this pass's `manifest.json` edit. (No release was created as part of this task, per instructions.)

## 2. `community-plugins.json` entry (reference)

This is the entry that corresponds to this plugin, in the same shape as existing entries in `obsidianmd/obsidian-releases/community-plugins.json`. Per the "Important" section above, this will most likely be generated by the community.obsidian.md portal on approval rather than hand-added — kept here as the definitive reference for what it should look like if a manual PR is ever needed.

```json
{
  "id": "exo",
  "name": "Exo",
  "author": "Mario Miletta",
  "description": "An agentic AI assistant in your sidebar, powered by the Claude or Codex CLI. Your vault becomes its working directory — with a refined, theme-aware chat UI.",
  "repo": "mariomile/obsidian-exo"
}
```

`repo` is derived from `git remote -v` → `https://github.com/mariomile/obsidian-exo.git` → `mariomile/obsidian-exo`.

## 3. Fallback PR text (only if a manual PR to `obsidian-releases` is ever pursued)

Not to be opened automatically — Mario opens this manually, and only if he decides to pursue the legacy PR path instead of (or alongside) the portal submission.

**PR title:**
```
Add Exo community plugin
```

**PR body:**
```markdown
# I am submitting a new Community Plugin

## Repo URL

Link to my repo: https://github.com/mariomile/obsidian-exo

## Release Checklist

- [x] I have tested the plugin on
  - [x]  Windows
  - [x]  macOS
  - [ ]  Linux
  - [ ]  Android (if applicable)
  - [ ]  iOS (if applicable)
- [x] My GitHub release contains all the required files (as individual files, not just in the source archive):
  - [x] `main.js`
  - [x] `manifest.json`
  - [x] `styles.css`
- [x] GitHub release name matches the exact version number specified in my manifest.json (**Note:** Use the exact version number, don't include a prefix `v`)
- [x] The `id` in my `manifest.json` matches the `id` in the `community-plugins.json` file.
- [x] My README.md describes the plugin's purpose and provides clear usage instructions.
- [x] I have read the developer policies at https://docs.obsidian.md/Developer+policies, and have assessed my plugin's adherence to these policies.
- [x] I have read the tips in https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines and made my best effort to follow them.
- [x] I have added a license in the LICENSE file.
- [x] My project respects and is compliant with the trademark policy: https://obsidian.md/trademark.
- [x] I have given a concise and clear description of what my plugin does in the `description` field of `manifest.json`, and it does not contain the word "Obsidian" or start with "This is a plugin for Obsidian".
- [x] I have not included the trademarked Obsidian logo in my plugin's own logo/icon.

## Notes for the reviewer

Exo spawns the locally installed `claude` and/or `codex` CLI as a child process to run agentic AI turns against the user's own Anthropic/OpenAI account. It makes no network requests itself and collects no data — this is disclosed in the README's "Privacy & Security" section. `isDesktopOnly: true` is set because of the `child_process` usage.
```
