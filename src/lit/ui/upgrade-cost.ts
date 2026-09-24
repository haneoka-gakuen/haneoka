import { html, nothing } from "lit";
import "../../styles/upgrade-cost.css";
export function upgradeCost(options: {
  label: string;
  from: number;
  to: number;
  items: ReadonlyArray<{ name: string; count: number; image?: string }>;
  locale?: string;
}) {
  return html`
    <section class="upgrade-cost" aria-label=${options.label}>
      <header>
        <strong>${options.label}</strong>
        <span>
          ${options.from}
          <span aria-hidden="true">→</span>
          ${options.to}
        </span>
      </header>
      <ul>
        ${options.items.map(
          (item) => html`
            <li>
              ${
                item.image
                  ? html`
                      <img src=${item.image} alt="" loading="lazy" />
                    `
                  : nothing
              }
              <span>${item.name}</span>
              <strong>×${item.count.toLocaleString(options.locale)}</strong>
            </li>
          `,
        )}
      </ul>
    </section>
  `;
}
