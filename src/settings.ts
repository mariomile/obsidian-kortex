import { App, PluginSettingTab, Setting } from "obsidian";
import type KortexPlugin from "./main";
import type { PermissionMode, ProviderId } from "./providers/types";

export interface MVASettings {
  provider: ProviderId;
  claudeBin: string;
  codexBin: string;
  claudeModel: string;
  codexModel: string;
  effort: string;
  systemPrompt: string;
  /** User-defined prompt templates surfaced in the "/" menu. */
  customPrompts: { name: string; prompt: string }[];
  /** Phase 1 default: false (pure chat). Phase 2 turns this on with gating. */
  toolsEnabled: boolean;
  permissionMode: PermissionMode;
  autoAllowRead: boolean;
  fastStartup: boolean;
  // Obsidian-native (Claude). All optional/toggleable.
  obsidianToolsEnabled: boolean;
  nativeFirst: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  featureSurfacing: boolean;
  featureWikilinkify: boolean;
  featureMiniGraph: boolean;
}

export const DEFAULT_SETTINGS: MVASettings = {
  provider: "claude",
  claudeBin: "",
  codexBin: "",
  claudeModel: "",
  codexModel: "",
  effort: "default",
  systemPrompt: "",
  customPrompts: [],
  toolsEnabled: false,
  permissionMode: "default",
  autoAllowRead: true,
  fastStartup: true,
  obsidianToolsEnabled: true,
  nativeFirst: false,
  memoryReadEnabled: true,
  memoryWriteEnabled: true,
  featureSurfacing: true,
  featureWikilinkify: false,
  featureMiniGraph: false,
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
    toggle("Mini-graph", "Show a small graph of the notes the agent touched each turn.", "featureMiniGraph");
  }
}
