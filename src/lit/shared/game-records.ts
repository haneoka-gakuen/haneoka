import { html } from "lit";
import { clientText } from "../../i18n/client";
import { profileRegion, type GameRecordsRegion } from "../../lib/game-records";
import type { ReleaseServer } from "../../lib/release-server";
import jpFlag from "circle-flags/flags/jp.svg?url";
import hkFlag from "circle-flags/flags/hk.svg?url";
import enUsFlag from "circle-flags/flags/language/en-us.svg?url";
import krFlag from "circle-flags/flags/kr.svg?url";

export const GAME_RECORDS_REGIONS = [
  { value: "jp", key: "regionJp", flag: jpFlag },
  { value: "tw", key: "regionTw", flag: hkFlag },
  { value: "en", key: "regionEn", flag: enUsFlag },
  { value: "kr", key: "regionKr", flag: krFlag },
] as const;

export const GAME_REGION_NAMES: Readonly<Record<GameRecordsRegion, string>> = { jp: "JP", tw: "TW/HK/MO", en: "EN Regions", kr: "KR" };

/** A linked game account's region comes from its player ID; older non-numeric IDs follow the stored server. */
export const gameAccountRegion = (server: string, locale: string, profileId = ""): GameRecordsRegion =>
  profileRegion(profileId) ?? (server === "jp" ? "jp" : defaultGameRecordsRegion("intl", locale));

export function defaultGameRecordsRegion(server: ReleaseServer, locale: string): GameRecordsRegion {
  if (server === "jp" || server === "jp-cbt") return "jp";
  return locale === "en" ? "en" : locale === "ko" ? "kr" : "tw";
}

export function gameRecordsRegionPicker(
  locale: string,
  region: GameRecordsRegion,
  onSelect: (region: GameRecordsRegion) => void,
  name = "ranking-region",
  regions: readonly GameRecordsRegion[] = GAME_RECORDS_REGIONS.map((option) => option.value),
) {
  const label = (key: string, fallback: string) => clientText(locale, `catalog.rankings.songs.${key}`, fallback);
  return html`
    <div
      class="settings-options song-ranking__regions"
      role="radiogroup"
      aria-label=${label("region", "Ranking region")}
    >
      ${GAME_RECORDS_REGIONS.filter((option) => regions.includes(option.value)).map(
        (option) => html`
          <label class="settings-option" title=${label(option.key, option.value)}>
            <input
              type="radio"
              name=${name}
              value=${option.value}
              .checked=${region === option.value}
              aria-label=${label(option.key, option.value)}
              @change=${() => onSelect(option.value)}
            />
            <span class="settings-option__face" aria-hidden="true">
              <span class="settings-option__image"><img src=${option.flag} width="28" height="28" alt="" /></span>
            </span>
            <span class="settings-option__tooltip" aria-hidden="true">${label(option.key, option.value)}</span>
          </label>
        `,
      )}
    </div>
  `;
}

