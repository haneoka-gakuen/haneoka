// L3 — GEB
// Input: Fandom／萌娘百科角色签名原图与原生 characterKey。
// Output: 站内图片、固有尺寸及来源页映射。
// Pos: [Map](../L2.md)；角色档案的静态素材索引。
// Effects/Dependencies: 无 I/O；图片在 public/images/character-signatures。
export interface CharacterSignature {
  image: string;
  width: number;
  height: number;
  sourceUrl: string;
}

export const characterSignatures: Readonly<Record<string, CharacterSignature>> = {
  "001": {
    image: "/images/character-signatures/1.png",
    width: 376,
    height: 100,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Takamatsu_Tomori_Signature.png",
  },
  "002": {
    image: "/images/character-signatures/2.png",
    width: 306,
    height: 182,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Chihaya_Anon_Signature.png",
  },
  "003": {
    image: "/images/character-signatures/3.png",
    width: 380,
    height: 134,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Kaname_Raana_Signature.png",
  },
  "004": {
    image: "/images/character-signatures/4.png",
    width: 302,
    height: 252,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Nagasaki_Soyo_Signature.png",
  },
  "005": {
    image: "/images/character-signatures/5.png",
    width: 324,
    height: 200,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Shiina_Taki_Signature.png",
  },
  "006": {
    image: "/images/character-signatures/6.png",
    width: 344,
    height: 200,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Doloris_Signature.png",
  },
  "007": {
    image: "/images/character-signatures/7.png",
    width: 346,
    height: 127,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Mortis_Signature.png",
  },
  "008": {
    image: "/images/character-signatures/8.png",
    width: 348,
    height: 187,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Timoris_Signature.png",
  },
  "009": {
    image: "/images/character-signatures/9.png",
    width: 335,
    height: 188,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Amoris_Signature.png",
  },
  "010": {
    image: "/images/character-signatures/10.png",
    width: 344,
    height: 125,
    sourceUrl: "https://bandori.fandom.com/wiki/File:Oblivionis_Signature.png",
  },
  "011": {
    image: "/images/character-signatures/11.png",
    width: 250,
    height: 221,
    sourceUrl: "https://zh.moegirl.org.cn/仲町阿拉蕾",
  },
  "012": {
    image: "/images/character-signatures/12.png",
    width: 250,
    height: 244,
    sourceUrl: "https://zh.moegirl.org.cn/宫永野乃花",
  },
  "013": {
    image: "/images/character-signatures/13.png",
    width: 300,
    height: 196,
    sourceUrl: "https://zh.moegirl.org.cn/峰月律",
  },
  "014": {
    image: "/images/character-signatures/14.png",
    width: 300,
    height: 176,
    sourceUrl: "https://zh.moegirl.org.cn/藤都子",
  },
  "015": {
    image: "/images/character-signatures/15.png",
    width: 300,
    height: 198,
    sourceUrl: "https://zh.moegirl.org.cn/千石由乃",
  },
  "016": {
    image: "/images/character-signatures/16.png",
    width: 705,
    height: 734,
    sourceUrl: "https://zh.moegirl.org.cn/汐见萤",
  },
  "017": {
    image: "/images/character-signatures/17.png",
    width: 1174,
    height: 898,
    sourceUrl: "https://zh.moegirl.org.cn/伊泽枣",
  },
  "018": {
    image: "/images/character-signatures/18.png",
    width: 918,
    height: 690,
    sourceUrl: "https://zh.moegirl.org.cn/琴平凪",
  },
  "019": {
    image: "/images/character-signatures/19.png",
    width: 1275,
    height: 353,
    sourceUrl: "https://zh.moegirl.org.cn/滨崎茉幌",
  },
  "020": {
    image: "/images/character-signatures/20.png",
    width: 1166,
    height: 549,
    sourceUrl: "https://zh.moegirl.org.cn/和泉朋花",
  },
  "021": {
    image: "/images/character-signatures/21.png",
    width: 859,
    height: 812,
    sourceUrl: "https://zh.moegirl.org.cn/须贺蕾叶",
  },
  "022": {
    image: "/images/character-signatures/22.png",
    width: 965,
    height: 581,
    sourceUrl: "https://zh.moegirl.org.cn/马桥心玖",
  },
  "023": {
    image: "/images/character-signatures/23.png",
    width: 1046,
    height: 913,
    sourceUrl: "https://zh.moegirl.org.cn/矢仓蓬咲",
  },
  "024": {
    image: "/images/character-signatures/24.png",
    width: 853,
    height: 905,
    sourceUrl: "https://zh.moegirl.org.cn/梅里千樱梨",
  },
  "025": {
    image: "/images/character-signatures/25.png",
    width: 1127,
    height: 571,
    sourceUrl: "https://zh.moegirl.org.cn/四宫宁月",
  },
};
