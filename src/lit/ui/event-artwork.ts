import { html, nothing } from "lit";
import { localeTaggedCandidates, nextImageCandidate, retryImageCandidates } from "./lazy-images";
import "../../styles/event-artwork.css";

/** The game's authored home banner, shared by event list and table thumbnails. */
export function eventBanner(image: string, label = "", deferred = true) {
  return html`
    <img
      class="event-banner"
      src=${deferred ? nothing : image}
      data-src=${deferred ? image : nothing}
      alt=${label}
      width="420"
      height="180"
      decoding="async"
      @error=${nextImageCandidate}
    />
  `;
}

/** The event's own illustration and title logo, composed inside a catalog tile. */
export function eventArtwork(image: string, logo: string, label: string, deferred = true, locale = "ja", banner = "") {
  const fallbacks = banner && banner !== image ? localeTaggedCandidates(banner, locale) : [];
  const backgrounds = [...localeTaggedCandidates(image, locale), ...fallbacks];
  const logos = localeTaggedCandidates(logo, locale);
  const eagerError = (event: Event) => {
    const element = event.currentTarget as HTMLImageElement;
    const candidates = element.classList.contains("event-artwork__logo") ? logos : backgrounds;
    retryImageCandidates(event, candidates);
  };
  return html`
    <span class="event-artwork" role="img" aria-label=${label}>
      <img
        class="event-artwork__background"
        src=${deferred ? nothing : backgrounds[0]}
        data-src=${deferred ? image : nothing}
        data-fallbacks=${deferred && fallbacks.length ? JSON.stringify(fallbacks) : nothing}
        alt=""
        decoding="async"
        @error=${deferred ? nextImageCandidate : eagerError}
      />
      <img
        class="event-artwork__logo"
        src=${deferred ? nothing : logos[0]}
        data-src=${deferred ? logo : nothing}
        alt=""
        decoding="async"
        @error=${deferred ? nextImageCandidate : eagerError}
      />
    </span>
  `;
}
