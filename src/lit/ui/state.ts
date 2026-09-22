import { html, nothing, type TemplateResult } from "lit";
import { icon } from "./icon";

/**
 * Loading / empty / error regions.
 *
 * One shape for all three, so "nothing here" reads the same on every route,
 * and so each one is announced: the loading region is a polite live region
 * and the error region an assertive alert, which hand-rolled spinners in the
 * individual workspaces never were.
 */

export function loadingState(label: string): TemplateResult {
  return html`
    <div class="state" role="status" aria-live="polite">
      <md-circular-progress indeterminate aria-hidden="true"></md-circular-progress>
      <p class="state__body">${label}</p>
    </div>
  `;
}

export interface EmptyStateOptions {
  title: string;
  body?: string;
  icon?: string;
  action?: TemplateResult;
}

export function emptyState(options: EmptyStateOptions): TemplateResult {
  return html`
    <div class="state" role="status">
      <span class="state__icon">${icon(options.icon || "search_off", 28)}</span>
      <p class="state__title">${options.title}</p>
      ${
        options.body
          ? html`
              <p class="state__body">${options.body}</p>
            `
          : nothing
      }
      ${
        options.action
          ? html`
              <div class="state__actions">${options.action}</div>
            `
          : nothing
      }
    </div>
  `;
}

export function errorState(title: string, retryLabel: string, onRetry: () => void, body?: string): TemplateResult {
  return html`
    <div class="state state--error" role="alert">
      <span class="state__icon">${icon("cloud_off", 28)}</span>
      <p class="state__title">${title}</p>
      ${
        body
          ? html`
              <p class="state__body">${body}</p>
            `
          : nothing
      }
      <div class="state__actions">
        <button class="button button--tonal" type="button" @click=${onRetry}>
          ${icon("refresh", 18)}
          <span>${retryLabel}</span>
        </button>
      </div>
    </div>
  `;
}
