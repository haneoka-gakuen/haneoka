import { html, nothing } from "lit";
import { bandRatingName } from "../../lib/band-rating";

export function bandRatingIcon(server: string, rank: number) {
  const name = bandRatingName(rank);
  if (!name) return nothing;
  return html`
    <img
      src=${`/assets/${server}/Assets/AddressableResources/UI/Texture/BandRank/ImgScorerank_${name}.png`}
      alt=${name}
      width="64"
      height="53"
      loading="lazy"
      decoding="async"
    />
  `;
}

export function highScoreRatingIcon(grade: number, step: number, label: string, sprites: ReadonlyMap<string, string>) {
  const name = ["GradeBronze", "GradeSilver", "GradeGold"][grade];
  return html`
    <span class="stack stack--flush" role="img" aria-label=${label}>
      <img src=${sprites.get(name)} alt="" width="40" height="40" loading="lazy" decoding="async" />
      <span class="row" style="--row-gap: 0px;" aria-hidden="true">
        ${[1, 2, 3, 4, 5].map(
          (index) => html`
            <img
              src=${sprites.get(index <= step ? "GradeStar_on" : "GradeStar_off")}
              alt=""
              width="8"
              height="9"
              loading="lazy"
              decoding="async"
            />
          `,
        )}
      </span>
    </span>
  `;
}
