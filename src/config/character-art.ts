export interface CharacterArt {
  source: string;
  width: number;
  height: number;
  bounds: readonly [number, number, number, number];
}
export const CHARACTER_ART: Readonly<Record<number, readonly CharacterArt[]>> = {
  1: [
    {
      source: "/images/characters/tomori_takamatsu/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [622, 187, 541, 1660],
    },
    {
      source: "/images/characters/tomori_takamatsu/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [712, 192, 392, 1661],
    },
  ],
  2: [
    { source: "/images/characters/anon_chihaya/portrait.png", width: 1800, height: 2160, bounds: [506, 0, 912, 1929] },
    {
      source: "/images/characters/anon_chihaya/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [402, 192, 789, 1734],
    },
  ],
  3: [
    { source: "/images/characters/rana_kaname/portrait.png", width: 1800, height: 2160, bounds: [619, 190, 901, 1682] },
    {
      source: "/images/characters/rana_kaname/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [525, 191, 788, 1682],
    },
  ],
  4: [
    {
      source: "/images/characters/soyo_nagasaki/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [300, 191, 1050, 1740],
    },
    {
      source: "/images/characters/soyo_nagasaki/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [533, 189, 639, 1743],
    },
  ],
  5: [
    { source: "/images/characters/taki_shiina/portrait.png", width: 1800, height: 2160, bounds: [630, 190, 564, 1666] },
    {
      source: "/images/characters/taki_shiina/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [426, 73, 806, 1783],
    },
  ],
  6: [
    { source: "/images/characters/uika_misumi/portrait.png", width: 1800, height: 2160, bounds: [549, 156, 963, 1714] },
    {
      source: "/images/characters/uika_misumi/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [606, 126, 523, 1844],
    },
  ],
  7: [
    {
      source: "/images/characters/mutsumi_wakaba/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [503, 111, 771, 1698],
    },
    {
      source: "/images/characters/mutsumi_wakaba/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [625, 147, 660, 1670],
    },
  ],
  8: [
    {
      source: "/images/characters/umiri_yahata/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [561, 139, 704, 1715],
    },
    {
      source: "/images/characters/umiri_yahata/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [726, 160, 557, 1696],
    },
  ],
  9: [
    {
      source: "/images/characters/nyamu_yutenji/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [541, 156, 688, 1742],
    },
    {
      source: "/images/characters/nyamu_yutenji/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [701, 153, 505, 1784],
    },
  ],
  10: [
    {
      source: "/images/characters/sakiko_togawa/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [358, 124, 1307, 1699],
    },
    {
      source: "/images/characters/sakiko_togawa/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [513, 123, 729, 1700],
    },
  ],
  11: [
    {
      source: "/images/characters/arale_nakamachi/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [424, 138, 815, 1695],
    },
    {
      source: "/images/characters/arale_nakamachi/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [516, 255, 768, 1733],
    },
  ],
  12: [
    {
      source: "/images/characters/nonoka_miyanaga/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [501, 172, 859, 1735],
    },
    {
      source: "/images/characters/nonoka_miyanaga/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [554, 147, 719, 1781],
    },
  ],
  13: [
    {
      source: "/images/characters/ritsu_minetsuki/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [570, 171, 636, 1628],
    },
    {
      source: "/images/characters/ritsu_minetsuki/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [640, 174, 471, 1712],
    },
  ],
  14: [
    { source: "/images/characters/miyako_fuji/portrait.png", width: 1200, height: 1440, bounds: [383, 108, 645, 1145] },
    {
      source: "/images/characters/miyako_fuji/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [653, 187, 634, 1604],
    },
  ],
  15: [
    {
      source: "/images/characters/yuno_sengoku/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [517, 157, 1080, 1804],
    },
    {
      source: "/images/characters/yuno_sengoku/portrait_alt.webp",
      width: 1800,
      height: 2160,
      bounds: [618, 138, 606, 1689],
    },
  ],
  16: [
    {
      source: "/images/characters/hotaru_shiomi/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [318, 159, 1143, 1647],
    },
    {
      source: "/images/characters/hotaru_shiomi/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [411, 159, 786, 1652],
    },
  ],
  17: [
    {
      source: "/images/characters/natsume_izawa/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [549, 159, 888, 1731],
    },
    {
      source: "/images/characters/natsume_izawa/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [688, 162, 426, 1758],
    },
  ],
  18: [
    {
      source: "/images/characters/nagi_kotohira/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [540, 133, 737, 1731],
    },
    {
      source: "/images/characters/nagi_kotohira/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [674, 136, 506, 1732],
    },
  ],
  19: [
    {
      source: "/images/characters/mahoro_hamasaki/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [553, 54, 742, 1781],
    },
    {
      source: "/images/characters/mahoro_hamasaki/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [607, 156, 571, 1683],
    },
  ],
  20: [
    { source: "/images/characters/houka_izumi/portrait.png", width: 1800, height: 2160, bounds: [656, 148, 495, 1757] },
    {
      source: "/images/characters/houka_izumi/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [588, 147, 571, 1763],
    },
  ],
  21: [
    { source: "/images/characters/raika_suga/portrait.png", width: 1800, height: 2160, bounds: [573, 164, 984, 1757] },
    {
      source: "/images/characters/raika_suga/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [609, 160, 691, 1759],
    },
  ],
  22: [
    {
      source: "/images/characters/miku_mahashi/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [582, 163, 818, 1770],
    },
    {
      source: "/images/characters/miku_mahashi/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [706, 163, 472, 1774],
    },
  ],
  23: [
    {
      source: "/images/characters/yomogi_yakura/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [637, 58, 497, 1925],
    },
    {
      source: "/images/characters/yomogi_yakura/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [456, 159, 591, 1796],
    },
  ],
  24: [
    {
      source: "/images/characters/chieri_umezato/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [561, 0, 609, 2012],
    },
    {
      source: "/images/characters/chieri_umezato/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [641, 288, 528, 1697],
    },
  ],
  25: [
    {
      source: "/images/characters/shizuku_shinomiya/portrait.png",
      width: 1800,
      height: 2160,
      bounds: [686, 164, 401, 1572],
    },
    {
      source: "/images/characters/shizuku_shinomiya/portrait_alt.png",
      width: 1800,
      height: 2160,
      bounds: [625, 163, 566, 1574],
    },
  ],
};
