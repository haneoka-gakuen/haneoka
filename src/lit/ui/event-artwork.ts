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

export function eventArtwork(
  illustration: string,
  logo: string,
  label: string,
  deferred = true,
  locale = "ja",
  banner = "",
) {
  const primary = illustration || banner;
  const illustrations = illustration ? localeTaggedCandidates(illustration, locale) : [];
  const banners = banner
    ? localeTaggedCandidates(banner, locale).filter((source) => !illustrations.includes(source))
    : [];
  const backgrounds = [...illustrations, ...banners];
  const logos = localeTaggedCandidates(logo, locale);
  const markBanner = (event: Event) => {
    const element = event.currentTarget as HTMLImageElement;
    element.toggleAttribute("data-event-banner", banners.includes(element.getAttribute("src") || ""));
  };
  const eagerError = (event: Event) => {
    const element = event.currentTarget as HTMLImageElement;
    const candidates = element.classList.contains("event-artwork__logo") ? logos : backgrounds;
    retryImageCandidates(event, candidates);
  };
  return html`
    <span class="event-artwork" role="img" aria-label=${label}>
      <img
        class="event-artwork__background"
        src=${deferred ? nothing : backgrounds[0] || nothing}
        data-src=${deferred && primary ? primary : nothing}
        data-fallbacks=${deferred && illustration && banners.length ? JSON.stringify(banners) : nothing}
        ?data-event-banner=${banners.includes(backgrounds[0])}
        alt=""
        decoding="async"
        @load=${markBanner}
        @error=${deferred ? nextImageCandidate : eagerError}
      />
      ${
        logo
          ? html`
              <img
                class="event-artwork__logo"
                src=${deferred ? nothing : logos[0]}
                data-src=${deferred ? logo : nothing}
                alt=""
                decoding="async"
                @error=${deferred ? nextImageCandidate : eagerError}
              />
            `
          : nothing
      }
    </span>
  `;
}
