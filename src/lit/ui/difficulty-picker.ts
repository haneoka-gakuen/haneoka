import { html } from "lit";
import { uiText } from "../shared/catalog";
import { rovingKeydown } from "./controls";
import "../../styles/difficulty-picker.css";

type Row = Record<string, unknown>;
const NAMES = ["easy", "normal", "hard", "expert", "master"];
export function difficultyKey(row: Row, index = 0): string {
  const value = String(row.difficultyName || row.difficulty || "").toLowerCase();
  return NAMES.includes(value) || value === "special" ? value : NAMES[Number(value) || index] || "master";
}
export function difficultyPicker(options: {
  rows: Row[];
  selected: string;
  locale: string;
  compact?: boolean;
  onSelect(key: string, index: number): void;
}) {
  const keys = options.rows.map(difficultyKey);
  const select = (key: string) => options.onSelect(key, keys.indexOf(key));
  return html`
    <span
      class=${`difficulty-picker${options.compact ? " difficulty-picker--compact" : ""}`}
      role="radiogroup"
      aria-label=${uiText(options.locale, "difficulty")}
      @click=${(event: Event) => event.stopPropagation()}
      @keydown=${rovingKeydown(keys, options.selected, select)}
    >
      ${options.rows.map((row, index) => {
        const key = keys[index]!;
        const level = row.displayLevel ?? row.playLevel ?? row.level ?? "—";
        const selected = key === options.selected;
        return html`
          <button
            type="button"
            role="radio"
            aria-checked=${selected}
            tabindex=${selected || (!keys.includes(options.selected) && index === 0) ? 0 : -1}
            aria-label=${`${key.toUpperCase()} ${level}`}
            title=${`${key.toUpperCase()} ${level}`}
            style=${`--chart-color:var(--md-extended-color-difficulty-${key === "special" ? "master" : key})`}
            @click=${() => select(key)}
          >
            <small>${key.toUpperCase()}</small>
            <b>${level}</b>
          </button>
        `;
      })}
    </span>
  `;
}
