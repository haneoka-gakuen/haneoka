import { html } from "lit";

export function bandRatingIcon(server: string, rank: number) {
  // UIBandRankIcon._type maps ranks 1–24 to D1–SS4.
  const name = `${["D", "C", "B", "A", "S", "SS"][Math.floor((rank - 1) / 4)]}${((rank - 1) % 4) + 1}`;
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
