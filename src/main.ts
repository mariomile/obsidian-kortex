import { Plugin, WorkspaceLeaf } from "obsidian";
import { ChatView, VIEW_TYPE } from "./view";
import { DEFAULT_SETTINGS, MVASettingTab, type MVASettings } from "./settings";

export default class MarioverseAgentPlugin extends Plugin {
  settings!: MVASettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("bot", "Open Marioverse Agent", () => this.activateView());

    this.addCommand({
      id: "open-marioverse-agent",
      name: "Open chat",
      callback: () => this.activateView(),
    });

    this.addSettingTab(new MVASettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
