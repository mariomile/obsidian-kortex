import { App, PluginSettingTab, Setting } from "obsidian";
import type KortexPlugin from "./main";
import type { PermissionMode, ProviderId } from "./providers/types";

export interface MVASettings {
  provider: ProviderId;
  claudeBin: string;
  codexBin: string;
  claudeModel: string;
  codexModel: string;
  /** Extra model ids (comma/newline separated) added to the model pickers. */
  claudeCustomModels: string;
  codexCustomModels: string;
  effort: string;
  systemPrompt: string;
  /** User-defined prompt templates surfaced in the "/" menu. */
  customPrompts: { name: string; prompt: string }[];
  /** Phase 1 default: false (pure chat). Phase 2 turns this on with gating. */
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  autoAllowRead: boolean;
  fastStartup: boolean;
  /** Codex sandbox + approval policy. */
  codexSandbox: string;
  codexApproval: string;
  /** Auto-compact the conversation when context fills (token saver, Claude). */
  autoCompactEnabled: boolean;
  /** Load native tool defs on-demand instead of always in context (saves tokens). */
  contextSavingMode: boolean;
  // Obsidian-native (Claude). All optional/toggleable.
  obsidianToolsEnabled: boolean;
  nativeFirst: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  featureSurfacing: boolean;
  featureWikilinkify: boolean;
  // Tab bar runtime state (not user-facing settings).
  openTabIds: string[];
  activeTabId: string;
}

export const DEFAULT_SETTINGS: MVASettings = {
  provider: "claude",
  claudeBin: "",
  codexBin: "",
  claudeModel: "",
  codexModel: "",
  claudeCustomModels: "",
  codexCustomModels: "",
  effort: "default",
  systemPrompt: "",
  customPrompts: [],
  toolsEnabled: false,
  permissionMode: "default",
  autoAllowRead: true,
  fastStartup: true,
  codexSandbox: "workspace-write",
  codexApproval: "on-request",
  autoCompactEnabled: true,
  contextSavingMode: false,
  obsidianToolsEnabled: true,
  nativeFirst: false,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  featureSurfacing: true,
  featureWikilinkify: false,
  openTabIds: [],
  activeTabId: "",
};

export class MVASettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: KortexPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Provider").setHeading();

    new Setting(containerEl)
      .setName("Default provider")
      .setDesc("Which CLI backend new conversations start with.")
      .addDropdown((d) =>
        d
          .addOption("claude", "Claude")
          .addOption("codex", "Codex")
          .setValue(this.plugin.settings.provider)
          .onChange(async (v) => {
            this.plugin.settings.provider = v as ProviderId;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Claude binary path")
      .setDesc("Leave empty to auto-detect. Run `which claude` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(this.plugin.settings.claudeBin)
          .onChange(async (v) => {
            this.plugin.settings.claudeBin = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Codex binary path")
      .setDesc("Leave empty to auto-detect. Run `which codex` if detection fails.")
      .addText((t) =>
        t
          .setPlaceholder("auto-detect")
          .setValue(this.plugin.settings.codexBin)
          .onChange(async (v) => {
            this.plugin.settings.codexBin = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Codex sandbox")
      .setDesc("Filesystem access for Codex when tools are enabled.")
      .addDropdown((d) =>
        d
          .addOptions({
            "read-only": "Read-only",
            "workspace-write": "Workspace write",
            "danger-full-access": "Full access (danger)",
          })
          .setValue(this.plugin.settings.codexSandbox)
          .onChange(async (v) => {
            this.plugin.settings.codexSandbox = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Codex approval policy")
      .setDesc("When Codex asks before running commands.")
      .addDropdown((d) =>
        d
          .addOptions({
            untrusted: "Untrusted (ask often)",
            "on-request": "On request",
            "on-failure": "On failure",
            never: "Never",
          })
          .setValue(this.plugin.settings.codexApproval)
          .onChange(async (v) => {
            this.plugin.settings.codexApproval = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom Claude models")
      .setDesc("Extra model ids to add to the Claude picker (comma or newline separated).")
      .addTextArea((t) =>
        t
          .setPlaceholder("claude-opus-4-6\nclaude-sonnet-4-6")
          .setValue(this.plugin.settings.claudeCustomModels)
          .onChange(async (v) => {
            this.plugin.settings.claudeCustomModels = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom Codex models")
      .setDesc("Extra model ids to add to the Codex picker (comma or newline separated).")
      .addTextArea((t) =>
        t
          .setPlaceholder("gpt-5-codex\no3")
          .setValue(this.plugin.settings.codexCustomModels)
          .onChange(async (v) => {
            this.plugin.settings.codexCustomModels = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Optional. Prepended persona/instructions for every conversation.")
      .addTextArea((t) =>
        t
          .setPlaceholder("(use the CLI's default)")
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (v) => {
            this.plugin.settings.systemPrompt = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom prompts")
      .setDesc('One per line as "Name | prompt text". Surfaced in the "/" menu in the composer.')
      .addTextArea((t) => {
        t.setPlaceholder("Summarize | Summarize the current note in 5 bullets")
          .setValue(this.plugin.settings.customPrompts.map((p) => `${p.name} | ${p.prompt}`).join("\n"))
          .onChange(async (v) => {
            this.plugin.settings.customPrompts = v
              .split("\n")
              .map((line) => {
                const i = line.indexOf("|");
                if (i < 0) return null;
                const name = line.slice(0, i).trim();
                const prompt = line.slice(i + 1).trim();
                return name && prompt ? { name, prompt } : null;
              })
              .filter((x): x is { name: string; prompt: string } => x !== null);
            await this.plugin.saveSettings();
          });
        t.inputEl.rows = 5;
      });

    new Setting(containerEl)
      .setName("Fast startup")
      .setDesc(
        "Skip global SessionStart hooks and MCP servers on each turn for much faster responses. " +
          "Turn off only if you need your MCP tools or hooks inside the chat."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.fastStartup).onChange(async (v) => {
          this.plugin.settings.fastStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Auto-compact (token saver)")
      .setDesc(
        "Automatically summarize and compact the conversation when the context window fills. " +
          "Strongly recommended to keep long chats from re-billing the whole history each turn. Claude only."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoCompactEnabled).onChange(async (v) => {
          this.plugin.settings.autoCompactEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Context-saving mode")
      .setDesc(
        "Load Obsidian-native tool definitions on demand instead of always in context. " +
          "Saves tokens every turn; the agent may take an extra step to discover a tool. Claude only."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.contextSavingMode).onChange(async (v) => {
          this.plugin.settings.contextSavingMode = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Agentic capabilities").setHeading();

    new Setting(containerEl)
      .setName("Enable tools (agentic mode)")
      .setDesc(
        "Let the agent read/write/edit files and run commands in your vault. " +
          "Phase 2 feature — permission prompts are wired up before this is safe to use."
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.toolsEnabled).onChange(async (v) => {
          this.plugin.settings.toolsEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("How tool use is approved. 'default' asks for each sensitive action.")
      .addDropdown((d) =>
        d
          .addOption("default", "Ask (default)")
          .addOption("acceptEdits", "Accept edits")
          .addOption("plan", "Plan only")
          .addOption("bypassPermissions", "Bypass (dangerous)")
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async (v) => {
            this.plugin.settings.permissionMode = v as PermissionMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-allow read-only tools")
      .setDesc("Don't prompt for Read/Glob/Grep/LS (no side effects).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoAllowRead).onChange(async (v) => {
          this.plugin.settings.autoAllowRead = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Obsidian-native").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Graph- and memory-aware features. Native tools and memory are Claude-only; graph UI works for both providers.",
    });

    const toggle = (name: string, desc: string, key: keyof typeof this.plugin.settings) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key] as boolean).onChange(async (v) => {
            (this.plugin.settings[key] as boolean) = v;
            await this.plugin.saveSettings();
          })
        );

    toggle(
      "Obsidian tools",
      "Give the agent native tools (search, read, backlinks, neighborhood, create/edit notes, frontmatter) alongside the standard ones.",
      "obsidianToolsEnabled"
    );
    toggle(
      "Native-first",
      "Disable the built-in file tools (Read/Grep/Glob/LS/Edit/Write) so the agent uses only the Obsidian-native tools for vault work. Bash stays available (gated).",
      "nativeFirst"
    );
    toggle(
      "Read vault memory",
      "Boot each conversation with context from _system/ (vault-context, preferences, rules, recent sessions).",
      "memoryReadEnabled"
    );
    toggle(
      "Write vault memory",
      "Let the agent capture decisions, learnings, and session-log entries into _system/ (every write is permission-gated).",
      "memoryWriteEnabled"
    );
    toggle("Surface related notes", "Show notes related to the active note in the empty state.", "featureSurfacing");
    toggle("Wikilink-ify replies", "Turn mentions of existing note titles in replies into clickable [[wikilinks]].", "featureWikilinkify");

    this.renderMcpSection(containerEl);
  }

  /** In-app management of the project's `.mcp.json` (loads when Fast startup is off). */
  private async renderMcpSection(containerEl: HTMLElement): Promise<void> {
    new Setting(containerEl).setName("MCP servers").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Manage external MCP servers in the project's .mcp.json (vault root). These load into Claude when Fast startup is OFF.",
    });

    const adapter = this.plugin.app.vault.adapter;
    const path = ".mcp.json";
    let current = '{\n  "mcpServers": {}\n}';
    try {
      if (await adapter.exists(path)) current = await adapter.read(path);
    } catch {
      /* missing — use template */
    }

    const status = containerEl.createEl("div", { cls: "setting-item-description" });
    const setStatus = (msg: string, ok: boolean) => {
      status.setText(msg);
      status.style.color = ok ? "var(--text-success, var(--text-muted))" : "var(--text-error)";
    };

    // Detected servers summary.
    const summary = containerEl.createEl("div", { cls: "setting-item-description" });
    const refreshSummary = (text: string) => {
      try {
        const names = Object.keys((JSON.parse(text)?.mcpServers ?? {}) as Record<string, unknown>);
        summary.setText(names.length ? `Servers: ${names.join(", ")}` : "No servers configured.");
      } catch {
        summary.setText("");
      }
    };
    refreshSummary(current);

    const area = new Setting(containerEl).setName(".mcp.json").setDesc("Edit and save. Must be valid JSON.");
    area.addTextArea((t) => {
      t.setValue(current);
      t.inputEl.rows = 10;
      t.inputEl.style.width = "100%";
      t.inputEl.style.fontFamily = "var(--font-monospace)";
      t.onChange(() => refreshSummary(t.getValue()));
      area.addButton((b) =>
        b
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            const raw = t.getValue();
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed !== "object" || parsed === null || typeof parsed.mcpServers !== "object") {
                setStatus('Invalid: expected an object with an "mcpServers" key.', false);
                return;
              }
              await adapter.write(path, JSON.stringify(parsed, null, 2));
              refreshSummary(raw);
              setStatus("Saved .mcp.json. Turn Fast startup off to load these servers.", true);
            } catch (e) {
              setStatus(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, false);
            }
          })
      );
    });
  }
}
