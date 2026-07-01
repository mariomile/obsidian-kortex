import { App, Modal } from "obsidian";

/** Ordered, unique `{{variable}}` names found in a prompt template. */
export function extractVars(text: string): string[] {
  const re = /\{\{\s*([\w-]+)\s*\}\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** Replace `{{var}}` placeholders with provided values (unfilled ones stay literal). */
export function fillVars(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, name: string) =>
    values[name] != null && values[name] !== "" ? values[name] : `{{${name}}}`
  );
}

/** Modal that collects one value per `{{variable}}` and returns the filled prompt. */
export class PromptVarsModal extends Modal {
  private values: Record<string, string> = {};
  constructor(
    app: App,
    private vars: string[],
    private onSubmit: (values: Record<string, string>) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("mva-ie-modal");
    this.titleEl.setText("Fill in the prompt");
    const { contentEl } = this;
    const inputs: HTMLInputElement[] = [];
    for (const v of this.vars) {
      const row = contentEl.createDiv({ cls: "mva-pv-row" });
      row.createDiv({ cls: "mva-pv-label", text: v });
      const input = row.createEl("input", { cls: "mva-pv-input", attr: { type: "text", placeholder: v } });
      input.addEventListener("input", () => (this.values[v] = input.value));
      inputs.push(input);
    }
    inputs[0]?.focus();
    const actions = contentEl.createDiv({ cls: "mva-pv-actions" });
    const submit = () => {
      this.onSubmit(this.values);
      this.close();
    };
    actions.createEl("button", { cls: "mva-btn mva-btn-primary", text: "Insert" }).onclick = submit;
    // Enter submits (unless focus is a multi-line field — these are single-line inputs).
    this.scope.register([], "Enter", (e) => {
      e.preventDefault();
      submit();
      return false;
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
