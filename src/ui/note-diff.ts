import { App, Modal } from "obsidian";
import { wordDiff } from "./inline-edit";

/**
 * Read-only modal showing what a turn changed in one note: a word-level diff of
 * the note's pre-turn snapshot (`before`) against its current content (`after`).
 * `before === null` means the note was created during the turn.
 */
export class NoteDiffModal extends Modal {
  constructor(
    app: App,
    private noteName: string,
    private before: string | null,
    private after: string,
    private onOpenNote: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText(this.noteName);
    const { contentEl } = this;
    const before = this.before ?? "";

    if (before === this.after) {
      contentEl.createDiv({
        cls: "mva-ie-orig",
        text: "No changes to show — the note matches its state before this turn.",
      });
    } else {
      if (this.before === null) {
        contentEl.createDiv({ cls: "mva-src-diff-note", text: "Created this turn." });
      }
      const diff = contentEl.createDiv({ cls: "mva-ie-preview mva-ie-diff" });
      for (const seg of wordDiff(before, this.after)) {
        diff.createSpan({ cls: `mva-ie-${seg.type}`, text: seg.text });
      }
    }

    const actions = contentEl.createDiv({ cls: "mva-ie-actions" });
    const open = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Open note" });
    open.onclick = () => {
      this.close();
      this.onOpenNote();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
