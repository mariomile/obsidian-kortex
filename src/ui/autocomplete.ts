import { setIcon } from "obsidian";

export interface AcItem {
  label: string;
  detail?: string;
  icon?: string;
  /** Text that replaces the trigger token (e.g. "/search " or a prompt body). */
  insert: string;
  onSelect?: () => void;
}

export interface AcProvider {
  trigger: string; // single char, e.g. "/" or "@"
  getItems: (query: string) => AcItem[] | Promise<AcItem[]>;
}

/**
 * Lightweight inline autocomplete for a <textarea>. Detects a trigger token
 * (e.g. `/foo` or `@bar`) at the caret and shows a filterable popup anchored
 * above the input. Keyboard: ↑/↓ navigate, ⏎/Tab select, Esc dismiss.
 */
export class Autocomplete {
  private popup: HTMLElement;
  private items: AcItem[] = [];
  private sel = 0;
  private open = false;
  private tokenStart = -1;
  private reqId = 0;

  constructor(
    private ta: HTMLTextAreaElement,
    anchor: HTMLElement,
    private providers: AcProvider[]
  ) {
    this.popup = anchor.createDiv({ cls: "mva-ac" });
    this.popup.hide();
    ta.addEventListener("input", () => void this.onInput());
    ta.addEventListener("keydown", (e) => this.onKey(e), true);
    ta.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
  }

  private async onInput(): Promise<void> {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    const m = before.match(/(^|\s)([/@])([^\s]*)$/);
    if (!m) {
      this.close();
      return;
    }
    const trigger = m[2];
    const query = m[3];
    const prov = this.providers.find((p) => p.trigger === trigger);
    if (!prov) {
      this.close();
      return;
    }
    this.tokenStart = pos - (1 + query.length);
    const id = ++this.reqId;
    const items = await prov.getItems(query);
    if (id !== this.reqId) return; // a newer query superseded this one
    this.items = items.slice(0, 50);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.sel = 0;
    this.render();
  }

  private render(): void {
    this.popup.empty();
    this.items.forEach((it, i) => {
      const row = this.popup.createDiv({ cls: "mva-ac-item" + (i === this.sel ? " is-sel" : "") });
      if (it.icon) setIcon(row.createSpan({ cls: "mva-ac-icon" }), it.icon);
      row.createSpan({ cls: "mva-ac-label", text: it.label });
      if (it.detail) row.createSpan({ cls: "mva-ac-detail", text: it.detail });
      row.onmousedown = (e) => {
        e.preventDefault();
        this.choose(i);
      };
    });
    this.popup.show();
    this.open = true;
    (this.popup.children[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      this.sel = (this.sel + 1) % this.items.length;
      this.render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      this.sel = (this.sel - 1 + this.items.length) % this.items.length;
      this.render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      this.choose(this.sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  private choose(i: number): void {
    const it = this.items[i];
    if (!it) return;
    const pos = this.ta.selectionStart;
    const v = this.ta.value;
    this.ta.value = v.slice(0, this.tokenStart) + it.insert + v.slice(pos);
    const caret = this.tokenStart + it.insert.length;
    this.ta.setSelectionRange(caret, caret);
    this.close();
    it.onSelect?.();
    this.ta.dispatchEvent(new Event("input"));
    this.ta.focus();
  }

  private close(): void {
    this.open = false;
    this.reqId++;
    this.popup.hide();
  }
}
