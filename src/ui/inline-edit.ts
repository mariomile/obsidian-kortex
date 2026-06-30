import { App, Modal, Notice, setIcon } from "obsidian";

export type InlineEditRunner = (instruction: string, text: string, signal: AbortSignal) => Promise<string>;

interface DiffSeg {
  type: "same" | "add" | "del";
  text: string;
}

/** Word-level diff via LCS. Returns ordered segments for rendering. */
export function wordDiff(a: string, b: string): DiffSeg[] {
  const split = (s: string) => s.split(/(\s+)/).filter((t) => t.length > 0);
  const aw = split(a);
  const bw = split(b);
  const n = aw.length;
  const m = bw.length;
  // LCS table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aw[i] === bw[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aw[i] === bw[j]) {
      push("same", aw[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", aw[i++]);
    } else {
      push("add", bw[j++]);
    }
  }
  while (i < n) push("del", aw[i++]);
  while (j < m) push("add", bw[j++]);
  return out;
}

/**
 * Inline-edit modal: takes a selection, asks for an instruction, runs the agent
 * for a one-shot rewrite, shows a word-level diff, and applies on Accept.
 */
export class InlineEditModal extends Modal {
  private controller: AbortController | null = null;

  constructor(
    app: App,
    private original: string,
    private run: InlineEditRunner,
    private onAccept: (next: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("Inline edit");
    const { contentEl } = this;

    const input = contentEl.createEl("textarea", {
      cls: "mva-ie-input",
      attr: { rows: "2", placeholder: "What should the agent do with the selection? (⏎ to run)" },
    });
    input.focus();

    const preview = contentEl.createDiv({ cls: "mva-ie-preview" });
    preview.createDiv({ cls: "mva-ie-orig", text: this.original });

    const actions = contentEl.createDiv({ cls: "mva-ie-actions" });
    const runBtn = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Generate" });

    let result = "";
    let phase: "input" | "result" = "input";

    const renderDiff = (next: string) => {
      result = next;
      phase = "result";
      preview.empty();
      const diff = preview.createDiv({ cls: "mva-ie-diff" });
      for (const seg of wordDiff(this.original, next)) {
        diff.createSpan({ cls: `mva-ie-${seg.type}`, text: seg.text });
      }
      actions.empty();
      const accept = actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Accept (⏎)" });
      accept.onclick = () => this.accept(result);
      const redo = actions.createEl("button", { cls: "mva-btn", text: "Try again" });
      redo.onclick = () => {
        phase = "input";
        preview.empty();
        preview.createDiv({ cls: "mva-ie-orig", text: this.original });
        actions.empty();
        actions.appendChild(runBtn);
        input.focus();
      };
      const reject = actions.createEl("button", { cls: "mva-btn mva-btn-danger", text: "Reject (esc)" });
      reject.onclick = () => this.close();
    };

    const generate = async () => {
      const instruction = input.value.trim();
      if (!instruction) {
        new Notice("Type an instruction first.");
        return;
      }
      actions.empty();
      const spinner = actions.createDiv({ cls: "mva-ie-loading" });
      setIcon(spinner.createSpan({ cls: "mva-ie-spin" }), "loader-2");
      spinner.createSpan({ text: "Working…" });
      const cancel = actions.createEl("button", { cls: "mva-btn", text: "Cancel" });
      this.controller = new AbortController();
      cancel.onclick = () => this.controller?.abort();
      try {
        const next = await this.run(instruction, this.original, this.controller.signal);
        if (this.controller.signal.aborted) {
          this.close();
          return;
        }
        renderDiff(next || this.original);
      } catch (err) {
        new Notice(`Inline edit failed: ${err instanceof Error ? err.message : String(err)}`);
        actions.empty();
        actions.appendChild(runBtn);
      }
    };

    runBtn.onclick = () => void generate();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void generate();
      }
    });
    this.scope.register([], "Enter", (e) => {
      if (phase === "result") {
        e.preventDefault();
        this.accept(result);
        return false;
      }
      return true;
    });
  }

  private accept(next: string): void {
    this.onAccept(next);
    this.close();
  }

  onClose(): void {
    this.controller?.abort();
    this.contentEl.empty();
  }
}
