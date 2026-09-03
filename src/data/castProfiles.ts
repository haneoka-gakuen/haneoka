export type CastLocalizedName = readonly [
  ja: string,
  en: string,
  zhTw: string,
  zhCn: string,
  ko: string,
];

export type CastLocalizedSourceUrls = readonly [
  ja: string,
  en: string,
  zhTw: string,
  zhCn: string,
  ko: string,
];

export interface CastMonthDay {
  readonly month: number;
  readonly day: number;
}

/**
 * A source URL always accompanies a profile fact. For `null` and empty-array
 * values, these are the official pages checked before leaving the field empty;
 * they are not evidence that the person has no such attribute.
 */
export interface SourcedCastFact<T> {
  readonly value: T;
  readonly sourceUrls: readonly [string, ...string[]];
}

export type CastOfficialLinkKind =
  | "agencyProfile"
  | "artistProfile"
  | "officialSite"
  | "officialSocial";

export interface CastOfficialLink {
  readonly kind: CastOfficialLinkKind;
  readonly label: string;
  readonly url: string;
}

export type OurNotesCastBandSlug = "mygo" | "avemujica" | "millsage" | "ikka-dumb-rock";
export type OurNotesCastCharacterSlug = `${OurNotesCastBandSlug}/${string}`;

export interface CastProfile {
  readonly id: string;
  /** Language order: Japanese, English, Traditional Chinese, Simplified Chinese, Korean. */
  readonly name: CastLocalizedName;
  readonly characterSlugs: readonly [OurNotesCastCharacterSlug, ...OurNotesCastCharacterSlug[]];
  /** These same official character pages establish both the localized name and role mapping. */
  readonly nameAndCharacterSourceUrls: CastLocalizedSourceUrls;
  readonly birthday: SourcedCastFact<CastMonthDay | null>;
  readonly agency: SourcedCastFact<string | null>;
  readonly birthplace: SourcedCastFact<string | null>;
  readonly bloodType: SourcedCastFact<string | null>;
  readonly heightCm: SourcedCastFact<number | null>;
  readonly hobbies: SourcedCastFact<readonly string[]>;
  readonly skills: SourcedCastFact<readonly string[]>;
  readonly qualifications: SourcedCastFact<readonly string[]>;
  /** A short Japanese summary of facts published by the linked primary source. */
  readonly biography: SourcedCastFact<string | null>;
  readonly officialLinks: readonly CastOfficialLink[];
}

const JAPANESE_CHARACTER_BASE = "https://bang-dream-on.bushimo.jp/character";
const GLOBAL_CHARACTER_BASE = "https://bdon.biligames.com/character";

const castNameSources = (characterSlug: OurNotesCastCharacterSlug): CastLocalizedSourceUrls => [
  `${JAPANESE_CHARACTER_BASE}/${characterSlug}/`,
  `${GLOBAL_CHARACTER_BASE}/${characterSlug}/?lang=en-us`,
  `${GLOBAL_CHARACTER_BASE}/${characterSlug}/?lang=zh-tw`,
  `${GLOBAL_CHARACTER_BASE}/${characterSlug}/?lang=zh-cn`,
  `${GLOBAL_CHARACTER_BASE}/${characterSlug}/?lang=ko-kr`,
];

const sourced = <const T>(
  value: T,
  sourceUrl: string,
  ...additionalSourceUrls: string[]
): SourcedCastFact<T> => ({
  value,
  sourceUrls: [sourceUrl, ...additionalSourceUrls],
});

const sources = {
  hinaYoumiya: "https://www.aoni.co.jp/search/yomiya-hina.html",
  rinTateishi: "https://hibiki-cast.jp/hibiki_f/tateishi_rin/",
  hinaAoki: "https://hibiki-cast.jp/hibiki_f/aoki_hina/",
  hinaAokiArtist: "https://bm-echoes.com/creators/aoki-hina/",
  mikaKohinata: "https://www.s-inc.jp/mika-kohinata",
  cocoHayashiAgency: "https://liberte2024.com/talent/hayashicoco",
  cocoHayashiOfficial: "https://fan.pia.jp/cocohayashi/page/profile/",
  cocoHayashiArchive: "https://rungirlsrun.jp/profile/",
  ricoSasaki: "https://sasakirico.com/profile.html",
  ricoSasakiArtist: "https://sasakirico.lantis.jp/profile/",
  yuzukiWatase: "https://hibiki-cast.jp/hibiki_f/watase_yuzuki/",
  meiOkadaAgency: "https://x.com/okada_mei0519",
  meiOkadaOfficial: "https://maysland.jp/",
  akaneYonezawa: "https://akaneyonezawa.com/profile",
  kanonTakao: "https://ancheri.co.jp/talent/kanon_takao.html",
  kanonTakaoOfficial: "https://kanon-takao.com/",
  riaYakushiji: "https://yu-rin.com/jr-woman/yakushiji-ria",
  chiharu: "https://hibiki-cast.jp/hibiki_f/chiharu/",
  asakiYuikawa: "https://www.imenterprise.jp/profile.php?id=178",
  yurieIgoma:
    "https://www.81produce.co.jp/actor_search/index.php/item?cell003=%E3%81%82%E8%A1%8C&cell004=&cell028=&cell029=%E5%A5%B3%E6%80%A7&id=395&keyword=&label=1&name=%E4%BC%8A%E9%A7%92%E3%80%80%E3%82%86%E3%82%8A%E3%81%88",
  hinanoSakikawa: "https://stay-luck.com/talent/sakikawa-hinano/",
  mayTachibana: "https://www.amuse.co.jp/artist/A9019/",
  sakuraSuzumi: "https://www.sma.co.jp/s/sma/artist/657?ima=0000&link=ROBO004",
  sakuraSuzumiProfile: "https://x.com/SuzumiSakura305/status/2072272119585820755",
  ninaHanamiya: "https://www.aoni.co.jp/search/hanamiya-niina.html",
  hanaHishikawa: "https://www.raccoon-dog.co.jp/talent/r20-hishikawa.html",
  hikaruTono: "https://hibiki-cast.jp/hibiki_f/tono_hikaru/",
} as const;

/** Profile facts last checked against their official sources on 2026-07-17. */
export const castProfilesVerifiedAt = "2026-07-17" as const;

export const castProfiles = [
  {
    id: "hina-youmiya",
    name: ["羊宮 妃那", "Hina Yomiya", "羊宮妃那", "羊宫妃那", "요우미야 히나"],
    characterSlugs: ["mygo/takamatsu-tomori"],
    nameAndCharacterSourceUrls: castNameSources("mygo/takamatsu-tomori"),
    birthday: sourced({ month: 3, day: 26 }, sources.hinaYoumiya),
    agency: sourced("株式会社青二プロダクション", sources.hinaYoumiya),
    birthplace: sourced("奈良県", sources.hinaYoumiya),
    bloodType: sourced(null, sources.hinaYoumiya),
    heightCm: sourced(null, sources.hinaYoumiya),
    hobbies: sourced(
      [
        "描画",
        "読書",
        "映画鑑賞",
        "音楽鑑賞",
        "アコースティックギター弾き語り",
        "作詞",
        "作曲",
      ],
      sources.hinaYoumiya,
    ),
    skills: sourced(["ダンス"], sources.hinaYoumiya),
    qualifications: sourced(["剣道初段"], sources.hinaYoumiya),
    biography: sourced(
      "関西弁を話し、第18回声優アワード新人声優賞を受賞。",
      sources.hinaYoumiya,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "青二プロダクション", url: sources.hinaYoumiya },
    ],
  },
  {
    id: "rin-tateishi",
    name: ["立石 凛", "Rin Tateishi", "立石凜", "立石凛", "타테이시 린"],
    characterSlugs: ["mygo/chihaya-anon"],
    nameAndCharacterSourceUrls: castNameSources("mygo/chihaya-anon"),
    birthday: sourced({ month: 7, day: 10 }, sources.rinTateishi),
    agency: sourced("響", sources.rinTateishi),
    birthplace: sourced(null, sources.rinTateishi),
    bloodType: sourced("B型", sources.rinTateishi),
    heightCm: sourced(null, sources.rinTateishi),
    hobbies: sourced(
      ["映像制作", "パズル", "YouTubeを見ること", "お笑い鑑賞"],
      sources.rinTateishi,
    ),
    skills: sourced(["ダンス", "そろばん"], sources.rinTateishi),
    qualifications: sourced([], sources.rinTateishi),
    biography: sourced(null, sources.rinTateishi),
    officialLinks: [
      { kind: "agencyProfile", label: "声優事務所 響", url: sources.rinTateishi },
    ],
  },
  {
    id: "hina-aoki",
    name: ["青木 陽菜", "Hina Aoki", "青木陽菜", "青木阳菜", "아오키 히나"],
    characterSlugs: ["mygo/kaname-rana"],
    nameAndCharacterSourceUrls: castNameSources("mygo/kaname-rana"),
    birthday: sourced({ month: 1, day: 5 }, sources.hinaAoki),
    agency: sourced("響", sources.hinaAoki),
    birthplace: sourced(null, sources.hinaAoki),
    bloodType: sourced("A型", sources.hinaAoki),
    heightCm: sourced(null, sources.hinaAoki),
    hobbies: sourced(
      ["ギター", "弾き語り", "一人カラオケ", "ライブ鑑賞"],
      sources.hinaAoki,
    ),
    skills: sourced(["ピアノ", "歌"], sources.hinaAoki),
    qualifications: sourced([], sources.hinaAoki),
    biography: sourced(
      "2023年3月から声優活動と並行して音楽活動を始め、オリジナル曲の作詞・作曲も手がける。",
      sources.hinaAokiArtist,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "声優事務所 響", url: sources.hinaAoki },
      { kind: "artistProfile", label: "BM-ECHOES", url: sources.hinaAokiArtist },
    ],
  },
  {
    id: "mika-kohinata",
    name: ["小日向 美香", "Mika Kohinata", "小日向美香", "小日向美香", "코히나타 미카"],
    characterSlugs: ["mygo/nagasaki-soyo"],
    nameAndCharacterSourceUrls: castNameSources("mygo/nagasaki-soyo"),
    birthday: sourced({ month: 3, day: 14 }, sources.mikaKohinata),
    agency: sourced("株式会社S", sources.mikaKohinata),
    birthplace: sourced(null, sources.mikaKohinata),
    bloodType: sourced("O型", sources.mikaKohinata),
    heightCm: sourced(156, sources.mikaKohinata),
    hobbies: sourced(["ダンス", "メロンパン食べ比べ"], sources.mikaKohinata),
    skills: sourced(["バスクラリネット", "料理"], sources.mikaKohinata),
    qualifications: sourced(["調理師免許"], sources.mikaKohinata),
    biography: sourced(
      "2020年に株式会社S声優養成スクールPineSを卒業し、同社所属となる。",
      sources.mikaKohinata,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "芸能部S", url: sources.mikaKohinata },
    ],
  },
  {
    id: "coco-hayashi",
    name: ["林 鼓子", "Coco Hayashi", "林鼓子", "林鼓子", "하야시 코코"],
    characterSlugs: ["mygo/shiina-taki"],
    nameAndCharacterSourceUrls: castNameSources("mygo/shiina-taki"),
    birthday: sourced({ month: 5, day: 15 }, sources.cocoHayashiArchive),
    agency: sourced("株式会社LIBERTE", sources.cocoHayashiAgency),
    birthplace: sourced("静岡県", sources.cocoHayashiArchive, sources.cocoHayashiOfficial),
    bloodType: sourced("A型", sources.cocoHayashiArchive),
    heightCm: sourced(null, sources.cocoHayashiArchive, sources.cocoHayashiOfficial),
    hobbies: sourced(["ミュージカル鑑賞"], sources.cocoHayashiArchive),
    skills: sourced(["イラストを描くこと", "ドラム"], sources.cocoHayashiArchive),
    qualifications: sourced([], sources.cocoHayashiArchive),
    biography: sourced(
      "2012年にテレビ東京『おはスタ645』でデビューし、以後アニメ・舞台作品に出演。",
      sources.cocoHayashiOfficial,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "LIBERTE", url: sources.cocoHayashiAgency },
      { kind: "officialSite", label: "林鼓子 Official Site", url: sources.cocoHayashiOfficial },
    ],
  },
  {
    id: "rico-sasaki",
    name: ["佐々木 李子", "Rico Sasaki", "佐佐木李子", "佐佐木李子", "사사키 리코"],
    characterSlugs: ["avemujica/misumi-uika"],
    nameAndCharacterSourceUrls: castNameSources("avemujica/misumi-uika"),
    birthday: sourced({ month: 11, day: 10 }, sources.ricoSasaki),
    agency: sourced(null, sources.ricoSasaki),
    birthplace: sourced("秋田県", sources.ricoSasaki),
    bloodType: sourced(null, sources.ricoSasaki),
    heightCm: sourced(null, sources.ricoSasaki),
    hobbies: sourced([], sources.ricoSasaki),
    skills: sourced([], sources.ricoSasaki),
    qualifications: sourced([], sources.ricoSasaki),
    biography: sourced(
      "幼少期から歌と音楽に親しみ、ミュージカル『アニー』主演を経て歌手・声優として活動。",
      sources.ricoSasaki,
    ),
    officialLinks: [
      { kind: "officialSite", label: "佐々木李子 Official Website", url: sources.ricoSasaki },
      { kind: "artistProfile", label: "Lantis", url: sources.ricoSasakiArtist },
    ],
  },
  {
    id: "yuzuki-watase",
    name: ["渡瀬 結月", "Yuzuki Watase", "渡瀨結月", "渡濑结月", "와타세 유즈키"],
    characterSlugs: ["avemujica/wakaba-mutsumi"],
    nameAndCharacterSourceUrls: castNameSources("avemujica/wakaba-mutsumi"),
    birthday: sourced({ month: 2, day: 18 }, sources.yuzukiWatase),
    agency: sourced("響", sources.yuzukiWatase),
    birthplace: sourced(null, sources.yuzukiWatase),
    bloodType: sourced("O型", sources.yuzukiWatase),
    heightCm: sourced(null, sources.yuzukiWatase),
    hobbies: sourced(["写真", "お菓子作り", "歌"], sources.yuzukiWatase),
    skills: sourced(["エレクトーン", "沢山食べること", "両利き"], sources.yuzukiWatase),
    qualifications: sourced([], sources.yuzukiWatase),
    biography: sourced(null, sources.yuzukiWatase),
    officialLinks: [
      { kind: "agencyProfile", label: "声優事務所 響", url: sources.yuzukiWatase },
    ],
  },
  {
    id: "mei-okada",
    name: ["岡田 夢以", "Mei Okada", "岡田夢以", "冈田梦以", "오카다 메이"],
    characterSlugs: ["avemujica/yahata-umiri"],
    nameAndCharacterSourceUrls: castNameSources("avemujica/yahata-umiri"),
    birthday: sourced({ month: 5, day: 19 }, sources.meiOkadaOfficial),
    agency: sourced("AceCrew Entertainment", sources.meiOkadaAgency),
    birthplace: sourced("埼玉県", sources.meiOkadaOfficial),
    bloodType: sourced("O型", sources.meiOkadaOfficial),
    heightCm: sourced(null, sources.meiOkadaOfficial),
    hobbies: sourced(["アニメを見ること", "イラストを描くこと"], sources.meiOkadaOfficial),
    skills: sourced(["茶道", "書道"], sources.meiOkadaOfficial),
    qualifications: sourced(["書道七段"], sources.meiOkadaOfficial),
    biography: sourced(null, sources.meiOkadaOfficial),
    officialLinks: [
      { kind: "officialSocial", label: "岡田夢以 公式X", url: sources.meiOkadaAgency },
      { kind: "officialSite", label: "MAY's LAND", url: sources.meiOkadaOfficial },
    ],
  },
  {
    id: "akane-yonezawa",
    name: ["米澤 茜", "Akane Yonezawa", "米澤茜", "米泽茜", "요네자와 아카네"],
    characterSlugs: ["avemujica/yutenji-nyamu"],
    nameAndCharacterSourceUrls: castNameSources("avemujica/yutenji-nyamu"),
    birthday: sourced(null, sources.akaneYonezawa),
    agency: sourced(null, sources.akaneYonezawa),
    birthplace: sourced("鳥取県", sources.akaneYonezawa),
    bloodType: sourced(null, sources.akaneYonezawa),
    heightCm: sourced(null, sources.akaneYonezawa),
    hobbies: sourced([], sources.akaneYonezawa),
    skills: sourced([], sources.akaneYonezawa),
    qualifications: sourced([], sources.akaneYonezawa),
    biography: sourced(
      "ドラマーと声優の二足の草鞋で活動する両利きドラマー。",
      sources.akaneYonezawa,
    ),
    officialLinks: [
      { kind: "officialSite", label: "AKANE YONEZAWA official HP", url: sources.akaneYonezawa },
    ],
  },
  {
    id: "kanon-takao",
    name: ["高尾 奏音", "Kanon Takao", "高尾奏音", "高尾奏音", "타카오 카논"],
    characterSlugs: ["avemujica/togawa-sakiko"],
    nameAndCharacterSourceUrls: castNameSources("avemujica/togawa-sakiko"),
    birthday: sourced({ month: 9, day: 10 }, sources.kanonTakao),
    agency: sourced("株式会社アンシェリ", sources.kanonTakao),
    birthplace: sourced("千葉県", sources.kanonTakao),
    bloodType: sourced("O型", sources.kanonTakao),
    heightCm: sourced(152, sources.kanonTakao),
    hobbies: sourced(
      ["ピアノの弾き語り", "作詞・作曲", "読書", "カフェ巡り", "絵画鑑賞", "ダジャレを考えること"],
      sources.kanonTakao,
    ),
    skills: sourced(
      ["ピアノ", "クラシック音楽の楽曲分析", "人の長所を見つけること"],
      sources.kanonTakao,
    ),
    qualifications: sourced(
      [
        "ミラノ国際ジュニアピアノコンクール 最高位ASSOLUTO第1位",
        "エレーナ・リヒテル国際ピアノコンクール 第1位",
      ],
      sources.kanonTakao,
    ),
    biography: sourced("プロ・フィット声優養成所卒業。", sources.kanonTakao),
    officialLinks: [
      { kind: "agencyProfile", label: "アンシェリ", url: sources.kanonTakao },
      { kind: "officialSite", label: "高尾山のんのん村", url: sources.kanonTakaoOfficial },
    ],
  },
  {
    id: "ria-yakushiji",
    name: ["薬師寺 李有", "Ria Yakushiji", "藥師寺李有", "药师寺李有", "야쿠시지 리아"],
    characterSlugs: ["millsage/shiomi-hotaru"],
    nameAndCharacterSourceUrls: castNameSources("millsage/shiomi-hotaru"),
    birthday: sourced({ month: 9, day: 11 }, sources.riaYakushiji),
    agency: sourced("株式会社ゆーりんプロ", sources.riaYakushiji),
    birthplace: sourced("東京都", sources.riaYakushiji),
    bloodType: sourced(null, sources.riaYakushiji),
    heightCm: sourced(null, sources.riaYakushiji),
    hobbies: sourced(["歌", "ダンス", "お絵かき", "散歩", "写真"], sources.riaYakushiji),
    skills: sourced(["歌", "ダンス"], sources.riaYakushiji),
    qualifications: sourced([], sources.riaYakushiji),
    biography: sourced(null, sources.riaYakushiji),
    officialLinks: [
      { kind: "agencyProfile", label: "ゆーりんプロ", url: sources.riaYakushiji },
    ],
  },
  {
    id: "chiharu",
    name: ["千春", "Chiharu", "千春", "千春", "치하루"],
    characterSlugs: ["millsage/izawa-natsume"],
    nameAndCharacterSourceUrls: castNameSources("millsage/izawa-natsume"),
    birthday: sourced({ month: 4, day: 10 }, sources.chiharu),
    agency: sourced("響", sources.chiharu),
    birthplace: sourced(null, sources.chiharu),
    bloodType: sourced("O型", sources.chiharu),
    heightCm: sourced(null, sources.chiharu),
    hobbies: sourced(["歌うこと", "ゲーム", "アニメ鑑賞"], sources.chiharu),
    skills: sourced(["関西弁", "子どものお世話"], sources.chiharu),
    qualifications: sourced(["保育士資格", "幼稚園教諭二種免許状"], sources.chiharu),
    biography: sourced(null, sources.chiharu),
    officialLinks: [
      { kind: "agencyProfile", label: "声優事務所 響", url: sources.chiharu },
    ],
  },
  {
    id: "asaki-yuikawa",
    name: ["結川 あさき", "Asaki Yuikawa", "結川麻希", "结川麻希", "유이카와 아사키"],
    characterSlugs: ["millsage/kotohira-nagi"],
    nameAndCharacterSourceUrls: castNameSources("millsage/kotohira-nagi"),
    birthday: sourced({ month: 2, day: 15 }, sources.asakiYuikawa),
    agency: sourced("株式会社アイムエンタープライズ", sources.asakiYuikawa),
    birthplace: sourced("東京都", sources.asakiYuikawa),
    bloodType: sourced(null, sources.asakiYuikawa),
    heightCm: sourced(null, sources.asakiYuikawa),
    hobbies: sourced(["音楽", "ゲーム"], sources.asakiYuikawa),
    skills: sourced(["フットサル"], sources.asakiYuikawa),
    qualifications: sourced(["日本漢字能力検定準1級"], sources.asakiYuikawa),
    biography: sourced(
      "日本ナレーション演技研究所出身。第19回声優アワード新人声優賞受賞。",
      sources.asakiYuikawa,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "アイムエンタープライズ", url: sources.asakiYuikawa },
    ],
  },
  {
    id: "yurie-igoma",
    name: ["伊駒 ゆりえ", "Yurie Igoma", "伊駒祐里惠", "伊驹祐里恵", "이고마 유리에"],
    characterSlugs: ["millsage/hamasaki-mahoro"],
    nameAndCharacterSourceUrls: castNameSources("millsage/hamasaki-mahoro"),
    birthday: sourced({ month: 2, day: 24 }, sources.yurieIgoma),
    agency: sourced("株式会社81プロデュース", sources.yurieIgoma),
    birthplace: sourced("東京都", sources.yurieIgoma),
    bloodType: sourced(null, sources.yurieIgoma),
    heightCm: sourced(null, sources.yurieIgoma),
    // The agency page combines these under 趣味・特技 and separates the groups with a line break.
    hobbies: sourced(["作曲", "台本制作", "テーマパークに行くこと"], sources.yurieIgoma),
    skills: sourced(["ダンス", "明太子パスタ作り"], sources.yurieIgoma),
    qualifications: sourced([], sources.yurieIgoma),
    biography: sourced("第18回声優アワード新人声優賞受賞。", sources.yurieIgoma),
    officialLinks: [
      { kind: "agencyProfile", label: "81プロデュース", url: sources.yurieIgoma },
    ],
  },
  {
    id: "hinano-sakikawa",
    name: ["咲川 ひなの", "Hinano Sakikawa", "咲川雛乃", "咲川雏乃", "사키카와 히나노"],
    characterSlugs: ["millsage/izumi-houka"],
    nameAndCharacterSourceUrls: castNameSources("millsage/izumi-houka"),
    birthday: sourced({ month: 1, day: 22 }, sources.hinanoSakikawa),
    agency: sourced("株式会社ステイラック", sources.hinanoSakikawa),
    birthplace: sourced("山形県", sources.hinanoSakikawa),
    bloodType: sourced(null, sources.hinanoSakikawa),
    heightCm: sourced(157, sources.hinanoSakikawa),
    hobbies: sourced(["柔軟", "ピアノ", "ヘアアレンジ"], sources.hinanoSakikawa),
    skills: sourced(["新体操"], sources.hinanoSakikawa),
    qualifications: sourced([], sources.hinanoSakikawa),
    biography: sourced(
      "2020年にFollow-Up養成所で学び、2022年からステイラック所属。",
      sources.hinanoSakikawa,
    ),
    officialLinks: [
      { kind: "agencyProfile", label: "ステイラック", url: sources.hinanoSakikawa },
    ],
  },
  {
    id: "may-tachibana",
    name: ["橘 めい", "May Tachibana", "橘芽衣", "橘芽衣", "타치바나 메이"],
    characterSlugs: ["ikka-dumb-rock/suga-raika"],
    nameAndCharacterSourceUrls: castNameSources("ikka-dumb-rock/suga-raika"),
    birthday: sourced({ month: 11, day: 19 }, sources.mayTachibana),
    agency: sourced("株式会社アミューズ", sources.mayTachibana),
    birthplace: sourced("東京都", sources.mayTachibana),
    bloodType: sourced("B型", sources.mayTachibana),
    heightCm: sourced(168, sources.mayTachibana),
    hobbies: sourced(["観劇", "読書", "絵を描くこと"], sources.mayTachibana),
    skills: sourced(["ダンス", "歌", "スポーツ全般"], sources.mayTachibana),
    qualifications: sourced([], sources.mayTachibana),
    biography: sourced(null, sources.mayTachibana),
    officialLinks: [
      { kind: "agencyProfile", label: "アミューズ", url: sources.mayTachibana },
    ],
  },
  {
    id: "sakura-suzumi",
    name: ["涼泉 桜花", "Sakura Suzumi", "涼泉櫻花", "凉泉樱花", "스즈미 사쿠라"],
    characterSlugs: ["ikka-dumb-rock/mahashi-miku"],
    nameAndCharacterSourceUrls: castNameSources("ikka-dumb-rock/mahashi-miku"),
    birthday: sourced({ month: 3, day: 5 }, sources.sakuraSuzumi),
    agency: sourced("株式会社ソニー・ミュージックアーティスツ", sources.sakuraSuzumi),
    birthplace: sourced(null, sources.sakuraSuzumi),
    bloodType: sourced(null, sources.sakuraSuzumi),
    heightCm: sourced(157, sources.sakuraSuzumi),
    hobbies: sourced(["バスケ観戦"], sources.sakuraSuzumiProfile),
    skills: sourced(["篠笛"], sources.sakuraSuzumiProfile),
    qualifications: sourced([], sources.sakuraSuzumi),
    biography: sourced(null, sources.sakuraSuzumi),
    officialLinks: [
      { kind: "agencyProfile", label: "Sony Music Artists", url: sources.sakuraSuzumi },
      {
        kind: "officialSocial",
        label: "涼泉桜花 公式X",
        url: "https://x.com/SuzumiSakura305",
      },
    ],
  },
  {
    id: "nina-hanamiya",
    name: ["花宮 初奈", "Nina Hanamiya", "花宮初奈", "花宫初奈", "하나미야 니나"],
    characterSlugs: ["ikka-dumb-rock/yakura-yomogi"],
    nameAndCharacterSourceUrls: castNameSources("ikka-dumb-rock/yakura-yomogi"),
    birthday: sourced({ month: 10, day: 24 }, sources.ninaHanamiya),
    agency: sourced("株式会社青二プロダクション", sources.ninaHanamiya),
    birthplace: sourced("大阪府", sources.ninaHanamiya),
    bloodType: sourced(null, sources.ninaHanamiya),
    heightCm: sourced(null, sources.ninaHanamiya),
    hobbies: sourced(
      ["料理", "歴史（特にエジプトに関して）", "リズムゲーム", "音楽鑑賞"],
      sources.ninaHanamiya,
    ),
    skills: sourced(["クラシックバレエ", "ジャズダンス", "歌唱"], sources.ninaHanamiya),
    qualifications: sourced(
      ["食品衛生責任者", "いけばな小原流 師範科二期"],
      sources.ninaHanamiya,
    ),
    biography: sourced(null, sources.ninaHanamiya),
    officialLinks: [
      { kind: "agencyProfile", label: "青二プロダクション", url: sources.ninaHanamiya },
    ],
  },
  {
    id: "hana-hishikawa",
    name: ["菱川 花菜", "Hana Hishikawa", "菱川花菜", "菱川花菜", "히시카와 하나"],
    characterSlugs: ["ikka-dumb-rock/umezato-chieri"],
    nameAndCharacterSourceUrls: castNameSources("ikka-dumb-rock/umezato-chieri"),
    birthday: sourced({ month: 5, day: 19 }, sources.hanaHishikawa),
    agency: sourced("株式会社ラクーンドッグ", sources.hanaHishikawa),
    birthplace: sourced("東京都", sources.hanaHishikawa),
    bloodType: sourced("A型", sources.hanaHishikawa),
    heightCm: sourced(160, sources.hanaHishikawa),
    hobbies: sourced(["絵を描く", "プロレス鑑賞", "サッカー鑑賞"], sources.hanaHishikawa),
    skills: sourced(["絵を描く", "ビビンバを混ぜる", "料理"], sources.hanaHishikawa),
    qualifications: sourced([], sources.hanaHishikawa),
    biography: sourced("プロ・フィット声優養成所卒業。", sources.hanaHishikawa),
    officialLinks: [
      { kind: "agencyProfile", label: "ラクーンドッグ", url: sources.hanaHishikawa },
    ],
  },
  {
    id: "hikaru-tono",
    name: ["遠野 ひかる", "Hikaru Tono", "遠野光", "远野光", "토오노 히카루"],
    characterSlugs: ["ikka-dumb-rock/shinomiya-shizuku"],
    nameAndCharacterSourceUrls: castNameSources("ikka-dumb-rock/shinomiya-shizuku"),
    birthday: sourced({ month: 3, day: 5 }, sources.hikaruTono),
    agency: sourced("響", sources.hikaruTono),
    birthplace: sourced(null, sources.hikaruTono),
    bloodType: sourced("O型", sources.hikaruTono),
    heightCm: sourced(null, sources.hikaruTono),
    hobbies: sourced(["舞台鑑賞", "ピアノ", "読書"], sources.hikaruTono),
    skills: sourced(["ダンス", "栄養管理"], sources.hikaruTono),
    qualifications: sourced(["家庭料理技能検定3級"], sources.hikaruTono),
    biography: sourced(null, sources.hikaruTono),
    officialLinks: [
      { kind: "agencyProfile", label: "声優事務所 響", url: sources.hikaruTono },
    ],
  },
] as const satisfies readonly CastProfile[];

export type CastProfileId = (typeof castProfiles)[number]["id"];
