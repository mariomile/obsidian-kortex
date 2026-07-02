import { App, Modal } from "obsidian";
import type { DreamPlan } from "../obsidian/dream";

const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;

/** Preview of a memory dream pass. Mutates nothing until the user clicks Apply. */
export class DreamModal extends Modal {
  constructor(app: App, private plan: DreamPlan, private onApply: () => void) {
    super(app);
  }
  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("Memory dream pass");
    const { contentEl } = this;
    const p = this.plan;
    const total = p.dedup.length + p.promote.length + p.stale.length;

    if (total === 0) {
      contentEl.createEl("p", { text: `Scanned ${p.scanned} learnings — nothing to consolidate right now.` });
      const acts = contentEl.createDiv({ cls: "mva-ie-actions" });
      acts.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Close" }).onclick = () => this.close();
      return;
    }

    contentEl.createEl("p", { text: `Scanned ${p.scanned} learnings. Proposed changes (every change is snapshotted and undoable):` });
    const section = (label: string, n: number, lines: string[]) => {
      if (!n) return;
      contentEl.createDiv({ cls: "mva-src-label", text: `${label} (${n})` });
      const ul = contentEl.createEl("ul");
      for (const t of lines) ul.createEl("li", { text: t });
    };
    section("Promote to rule", p.promote.length, p.promote.map((x) => `${base(x.from)} — evidence ${x.evidence}`));
    section("Merge duplicates", p.dedup.length, p.dedup.map((x) => `${base(x.keep)} + ${x.drop.length} duplicate(s) — evidence ${x.evidence}`));
    section("Mark stale", p.stale.length, p.stale.map((x) => `${base(x.path)} — last updated ${x.lastUpdated}`));

    const acts = contentEl.createDiv({ cls: "mva-ie-actions" });
    acts.createEl("button", { cls: "mva-btn", text: "Cancel" }).onclick = () => this.close();
    acts.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Apply" }).onclick = () => {
      this.onApply();
      this.close();
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
