export const CHARACTER_PROFILE_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;

export type CharacterProfileLocale = (typeof CHARACTER_PROFILE_LOCALES)[number];
export type CharacterBand =
  | "mygo"
  | "avemujica"
  | "yumemita"
  | "millsage"
  | "ikka-dumb-rock";
export type CharacterRole = "Vo." | "Gt." | "Ba." | "Dr." | "Key." | "DJ&Mp." | "Gt.&Vo." | "Key.&Vo.";

export type LocalizedCharacterText = readonly [string, string, string, string, string];
export type LocalizedOptionalCharacterText = readonly [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
];

export interface CharacterProfile {
  readonly id: `${CharacterBand}/${string}`;
  readonly band: CharacterBand;
  readonly bandName: LocalizedCharacterText;
  readonly slug: string;
  readonly role: CharacterRole;
  readonly name: LocalizedCharacterText;
  readonly description: LocalizedCharacterText;
  readonly affiliation: LocalizedOptionalCharacterText;
  readonly className: LocalizedOptionalCharacterText;
  readonly birthday: LocalizedOptionalCharacterText;
  readonly favoriteFoods: LocalizedOptionalCharacterText;
  readonly hobbies: LocalizedOptionalCharacterText;
  readonly castName: LocalizedOptionalCharacterText;
  readonly images: readonly [string, string];
  readonly sources: { readonly ja: string; readonly global: string };
}

/**
 * Official character facts collected on 2026-07-17. Localized slots always follow
 * CHARACTER_PROFILE_LOCALES. Descriptions are concise paraphrases; source links point
 * to the official pages for the complete wording. Missing official values stay null.
 */
export const characterProfiles = [
  {
    id: "mygo/chihaya-anon",
    band: "mygo",
    bandName: [
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!"
    ],
    slug: "chihaya-anon",
    role: "Gt.",
    name: [
      "千早 愛音",
      "Anon Chihaya",
      "千早愛音",
      "千早爱音",
      "치하야 아논"
    ],
    description: [
      "明るく社交的なMyGO!!!!!のギタリスト。行動力があり、バンドを前へ動かす役目を担う。",
      "A bright, sociable MyGO!!!!! guitarist whose initiative keeps the band moving.",
      "MyGO!!!!!開朗又善於交際的吉他手，以行動力推動樂團前進。",
      "MyGO!!!!!开朗又善于交际的吉他手，以行动力推动乐队前进。",
      "밝고 사교적인 MyGO!!!!!의 기타리스트로, 행동력 있게 밴드를 이끈다."
    ],
    affiliation: [
      "羽丘女子学園",
      "Haneoka Girls' Academy",
      "羽丘女子學園",
      "羽丘女子学园",
      "하네오카 여학원"
    ],
    className: [
      "1-A",
      "1-A",
      "1-A",
      "1-A",
      "1-A"
    ],
    birthday: [
      "9月8日",
      "September 8",
      "9月8日",
      "9月8日",
      "9월 8일"
    ],
    favoriteFoods: [
      "フルーツサンド、スモークサーモン",
      "Fruit sandwiches, smoked salmon",
      "水果三明治、煙燻鮭魚",
      "水果三明治、烟熏三文鱼",
      "과일 샌드위치, 훈제 연어"
    ],
    hobbies: [
      "美容系動画のチェック",
      "Checking beauty-related videos",
      "觀看美妝影片",
      "看美妆视频",
      "뷰티 관련 영상 보기"
    ],
    castName: [
      "立石 凛",
      "Rin Tateishi",
      "立石凜",
      "立石凛",
      "타테이시 린"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_chihaya-anon.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_chihaya-anon_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/mygo/chihaya-anon/",
      "global": "https://bdon.biligames.com/character/mygo/chihaya-anon/"
    },
  },
  {
    id: "mygo/nagasaki-soyo",
    band: "mygo",
    bandName: [
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!"
    ],
    slug: "nagasaki-soyo",
    role: "Ba.",
    name: [
      "長崎 そよ",
      "Soyo Nagasaki",
      "長崎爽世",
      "长崎爽世",
      "나가사키 소요"
    ],
    description: [
      "穏やかで頼りになるMyGO!!!!!のベーシスト。学校では周囲を支える一方、バンドでは別の表情も見せる。",
      "MyGO!!!!!’s calm, dependable bassist, supportive at school but more complex around her bandmates.",
      "MyGO!!!!!沉穩可靠的貝斯手；在學校照顧眾人，面對團員時也會展露不同一面。",
      "MyGO!!!!!沉稳可靠的贝斯手；在学校照顾众人，面对队友时也会展露不同一面。",
      "차분하고 믿음직한 MyGO!!!!!의 베이시스트로, 학교와 밴드에서 서로 다른 면모를 보인다."
    ],
    affiliation: [
      "月ノ森女子学園",
      "Tsukinomori Girls' Academy",
      "月之森女子學園",
      "月之森女子学园",
      "츠키노모리 여학원"
    ],
    className: [
      "1-A",
      "1-A",
      "1-A",
      "1-A",
      "1-A"
    ],
    birthday: [
      "5月27日",
      "May 27",
      "5月27日",
      "5月27日",
      "5월 27일"
    ],
    favoriteFoods: [
      "紅茶、ミネストローネ",
      "Tea, minestrone soup",
      "紅茶、義大利蔬菜湯",
      "红茶、意式蔬菜浓汤",
      "홍차, 미네스트로네"
    ],
    hobbies: [
      "アロマ",
      "Aromatherapy",
      "香氛",
      "香薰",
      "아로마"
    ],
    castName: [
      "小日向 美香",
      "Mika Kohinata",
      "小日向美香",
      "小日向美香",
      "코히나타 미카"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_nagasaki-soyo.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_nagasaki-soyo_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/mygo/nagasaki-soyo/",
      "global": "https://bdon.biligames.com/character/mygo/nagasaki-soyo/"
    },
  },
  {
    id: "mygo/takamatsu-tomori",
    band: "mygo",
    bandName: [
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!"
    ],
    slug: "takamatsu-tomori",
    role: "Vo.",
    name: [
      "高松 燈",
      "Tomori Takamatsu",
      "高松燈",
      "高松灯",
      "타카마츠 토모리"
    ],
    description: [
      "独特の感性を持つMyGO!!!!!のボーカル。小さなものを集めるのが好きで、学校では親しまれている。",
      "MyGO!!!!!’s sensitive vocalist, fond of collecting small treasures and warmly regarded at school.",
      "MyGO!!!!!感性獨特的主唱，喜歡蒐集小物，也深受校園同學喜愛。",
      "MyGO!!!!!感性独特的主唱，喜欢收集小物，也深受学校同学喜爱。",
      "독특한 감성을 지닌 MyGO!!!!!의 보컬로, 작은 물건을 모으길 좋아하며 학교에서 사랑받는다."
    ],
    affiliation: [
      "羽丘女子学園",
      "Haneoka Girls' Academy",
      "羽丘女子學園",
      "羽丘女子学园",
      "하네오카 여학원"
    ],
    className: [
      "1-A",
      "1-A",
      "1-A",
      "1-A",
      "1-A"
    ],
    birthday: [
      "11月22日",
      "November 22",
      "11月22日",
      "11月22日",
      "11월 22일"
    ],
    favoriteFoods: [
      "金平糖、味付けのり、ふりかけ",
      "Konpeito, seasoned seaweed, furikake",
      "金平糖、調味海苔、香鬆",
      "金平糖、调味海苔、香松",
      "별사탕, 양념김, 후리카케"
    ],
    hobbies: [
      "好きなもの集め（石、絆創膏、きれいな葉っぱなど）",
      "Collecting things she likes (stones, bandages, pretty leaves, etc.)",
      "收集喜歡的東西（石頭、OK繃、美麗的樹葉等）",
      "收集喜欢的东西(石头、创可贴、好看的树叶等)",
      "좋아하는 물건 수집 (돌, 반창고, 예쁜 나뭇잎 등)"
    ],
    castName: [
      "羊宮 妃那",
      "Hina Yomiya",
      "羊宮妃那",
      "羊宫妃那",
      "요우미야 히나"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_takamatsu-tomori.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_takamatsu-tomori_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/mygo/takamatsu-tomori/",
      "global": "https://bdon.biligames.com/character/mygo/takamatsu-tomori/"
    },
  },
  {
    id: "mygo/shiina-taki",
    band: "mygo",
    bandName: [
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!"
    ],
    slug: "shiina-taki",
    role: "Dr.",
    name: [
      "椎名 立希",
      "Taki Shiina",
      "椎名立希",
      "椎名立希",
      "시이나 타키"
    ],
    description: [
      "ぶっきらぼうだが認めた相手には一途なMyGO!!!!!のドラマー。ライブハウスRiNGでも働いている。",
      "MyGO!!!!!’s blunt but fiercely loyal drummer, who also works at the RiNG live house.",
      "MyGO!!!!!直率卻十分重情的鼓手，也在展演空間RiNG打工。",
      "MyGO!!!!!直率却十分重情的鼓手，也在演出场馆RiNG打工。",
      "무뚝뚝하지만 인정한 사람에게는 한결같은 MyGO!!!!!의 드러머이며 RiNG에서도 일한다."
    ],
    affiliation: [
      "花咲川女子学園",
      "Hanasakigawa Girls' Academy",
      "花咲川女子學園",
      "花咲川女子学园",
      "하나사키가와 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "8月9日",
      "August 9",
      "8月9日",
      "8月9日",
      "8월 9일"
    ],
    favoriteFoods: [
      "杏仁豆腐",
      "Almond tofu",
      "杏仁豆腐",
      "杏仁豆腐",
      "행인두부"
    ],
    hobbies: [
      "パンダグッズ集め、ひとりカラオケ",
      "Collecting panda merchandise, singing karaoke alone",
      "收集熊貓周邊、一個人唱卡拉OK",
      "收集熊猫周边、一个人唱卡拉OK",
      "판다 굿즈 수집, 혼자 노래방 가기"
    ],
    castName: [
      "林 鼓子",
      "Coco Hayashi",
      "林鼓子",
      "林鼓子",
      "하야시 코코"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shiina-taki.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shiina-taki_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/mygo/shiina-taki/",
      "global": "https://bdon.biligames.com/character/mygo/shiina-taki/"
    },
  },
  {
    id: "mygo/kaname-rana",
    band: "mygo",
    bandName: [
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!",
      "MyGO!!!!!"
    ],
    slug: "kaname-rana",
    role: "Gt.",
    name: [
      "要 楽奈",
      "Rāna Kaname",
      "要樂奈",
      "要乐奈",
      "카나메 라나"
    ],
    description: [
      "興味の赴くままに動く自由なMyGO!!!!!のギタリスト。音楽に囲まれて育ち、高い演奏力を持つ。",
      "A free-spirited MyGO!!!!! guitarist who follows her curiosity and plays with exceptional skill.",
      "MyGO!!!!!隨興又自由的吉他手，跟著興趣行動，並擁有出色的演奏實力。",
      "MyGO!!!!!随性又自由的吉他手，跟着兴趣行动，并拥有出色的演奏实力。",
      "흥미를 따라 자유롭게 움직이는 MyGO!!!!!의 기타리스트로, 뛰어난 연주 실력을 지녔다."
    ],
    affiliation: [
      "花咲川女子学園 中等部",
      "Hanasakigawa Girls' Academy Mid School",
      "花咲川女子學園 國中部",
      "花咲川女子学园 初中部",
      "하나사키가와 여학원 중등부"
    ],
    className: [
      "3-A",
      "3-A",
      "3-A",
      "3-A",
      "3-A"
    ],
    birthday: [
      "2月22日",
      "February 22",
      "2月22日",
      "2月22日",
      "2월 22일"
    ],
    favoriteFoods: [
      "抹茶、そば、ゆべし、軽羹（かるかん）",
      "Matcha, soba noodles, yubeshi, and karukan",
      "抹茶、蕎麥麵、柚子餅、輕羹",
      "抹茶、荞麦面、柚子饼、轻羹",
      "말차, 소바, 유베시, 카루칸"
    ],
    hobbies: [
      "ねこと遊ぶこと",
      "Playing with cats",
      "跟貓玩",
      "和猫一起玩",
      "고양이와 놀기"
    ],
    castName: [
      "青木 陽菜",
      "Hina Aoki",
      "青木陽菜",
      "青木阳菜",
      "아오키 히나"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_kaname-rana.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_kaname-rana_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/mygo/kaname-rana/",
      "global": "https://bdon.biligames.com/character/mygo/kaname-rana/"
    },
  },
  {
    id: "avemujica/togawa-sakiko",
    band: "avemujica",
    bandName: [
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica"
    ],
    slug: "togawa-sakiko",
    role: "Key.",
    name: [
      "オブリビオニス / 豊川 祥子",
      "Oblivionis / Sakiko Togawa",
      "Oblivionis /豐川祥子",
      "Oblivionis / 丰川祥子",
      "오블리비오니스 / 토가와 사키코"
    ],
    description: [
      "気品ある羽丘女子学園の1年生。強い覚悟でAve Mujicaを結成し、その世界観を守っている。",
      "An elegant Haneoka first-year who founded Ave Mujica with firm resolve and protects its vision.",
      "氣質高雅的羽丘一年級生，以堅定決心組成Ave Mujica並守護其世界觀。",
      "气质高雅的羽丘一年级生，以坚定决心组建Ave Mujica并守护其世界观。",
      "기품 있는 하네오카 1학년생으로, 굳은 각오로 Ave Mujica를 결성해 그 세계관을 지킨다."
    ],
    affiliation: [
      "羽丘女子学園",
      "Haneoka Girls' Academy",
      "羽丘女子學園",
      "羽丘女子学园",
      "하네오카 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "2月14日",
      "February 14",
      "2月14日",
      "2月14日",
      "2월 14일"
    ],
    favoriteFoods: [
      "紅茶、チョコレート",
      "Black tea, chocolate",
      "紅茶、巧克力",
      "红茶、巧克力",
      "홍차, 초콜릿"
    ],
    hobbies: [
      "芸術鑑賞、読書",
      "Art appreciation, reading",
      "藝術欣賞、閱讀",
      "艺术鉴赏、读书",
      "예술 감상, 독서"
    ],
    castName: [
      "高尾 奏音",
      "Kanon Takao",
      "高尾奏音",
      "高尾奏音",
      "타카오 카논"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_togawa-sakiko.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_togawa-sakiko_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/avemujica/togawa-sakiko/",
      "global": "https://bdon.biligames.com/character/avemujica/togawa-sakiko/"
    },
  },
  {
    id: "avemujica/yahata-umiri",
    band: "avemujica",
    bandName: [
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica"
    ],
    slug: "yahata-umiri",
    role: "Ba.",
    name: [
      "ティモリス / 八幡 海鈴",
      "Timoris / Umiri Yahata",
      "Timoris /八幡海鈴",
      "Timoris / 八幡海铃",
      "티모리스 / 야하타 우미리"
    ],
    description: [
      "プロ級の腕を持つAve Mujicaのベーシスト。演奏だけでなく予定管理などの実務も着実にこなす。",
      "Ave Mujica’s professional-level bassist, equally reliable onstage and in coordinating the group.",
      "Ave Mujica具職業級實力的貝斯手，也可靠地處理團內行程等事務。",
      "Ave Mujica拥有职业级实力的贝斯手，也可靠地处理乐队行程等事务。",
      "프로급 실력의 Ave Mujica 베이시스트로, 연주뿐 아니라 일정 관리도 빈틈없이 해낸다."
    ],
    affiliation: [
      "花咲川女子学園",
      "Hanasakigawa Girls' Academy",
      "花咲川女子學園",
      "花咲川女子学园",
      "하나사키가와 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "4月7日",
      "April 7",
      "4月7日",
      "4月7日",
      "4월 7일"
    ],
    favoriteFoods: [
      "目玉焼きの乗った焼きそば",
      "Fried noodles with a sunny-side-up egg",
      "加了荷包蛋的炒麵",
      "加了荷包蛋的炒面",
      "달걀 프라이가 올라간 야키소바"
    ],
    hobbies: [
      "音楽鑑賞、音響機器のカスタマイズ、LP収集、シルバーアクセサリー収集",
      "Music appreciation, customizing audio equipment, collecting vinyl record, collecting silver jewelry",
      "音樂欣賞、自組音響器材、收藏黑膠唱片、收集銀飾",
      "音乐鉴赏、自己组配音响器材、黑胶唱片收藏、银饰收藏",
      "음악 감상, 음향기기 커스터마이징, LP 수집, 실버 액세서리 수집"
    ],
    castName: [
      "岡田 夢以",
      "Mei Okada",
      "岡田夢以",
      "冈田梦以",
      "오카다 메이"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yahata-umiri.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yahata-umiri_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/avemujica/yahata-umiri/",
      "global": "https://bdon.biligames.com/character/avemujica/yahata-umiri/"
    },
  },
  {
    id: "avemujica/misumi-uika",
    band: "avemujica",
    bandName: [
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica"
    ],
    slug: "misumi-uika",
    role: "Gt.&Vo.",
    name: [
      "ドロリス / 三角 初華",
      "Doloris / Uika Misumi",
      "Doloris /三角初華",
      "Doloris / 三角初华",
      "돌로리스 / 미스미 우이카"
    ],
    description: [
      "アイドルとしても活動するAve Mujicaのギター＆ボーカル。星が好きで、バンドでは作詞を担う。",
      "Ave Mujica’s guitarist-vocalist and active idol, a stargazer who also writes the band’s lyrics.",
      "同時從事偶像活動的Ave Mujica吉他主唱，喜愛星空並負責樂團作詞。",
      "同时从事偶像活动的Ave Mujica吉他主唱，喜爱星空并负责乐队作词。",
      "아이돌로도 활동하는 Ave Mujica의 기타 보컬로, 별을 좋아하며 작사를 맡는다."
    ],
    affiliation: [
      "花咲川女子学園",
      "Hanasakigawa Girls' Academy",
      "花咲川女子學園",
      "花咲川女子学园",
      "하나사키가와 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "6月26日",
      "June 26",
      "6月26日",
      "6月26日",
      "6월 26일"
    ],
    favoriteFoods: [
      "オリーブのマリネ、魚、そうめん",
      "Pickled olives, fish, somen",
      "醃漬橄欖、魚、素麵",
      "腌橄榄、鱼、素面",
      "올리브 마리네이드, 생선, 소면"
    ],
    hobbies: [
      "プラネタリウム鑑賞、映画鑑賞、読書",
      "Planetarium appreciation, watching films, reading",
      "去星象館、電影欣賞、閱讀",
      "在星象馆观赏星象、电影鉴赏、读书",
      "플라네타리움 가기, 영화 감상, 독서"
    ],
    castName: [
      "佐々木 李子",
      "Rico Sasaki",
      "佐佐木李子",
      "佐佐木李子",
      "사사키 리코"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_misumi-uika.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_misumi-uika_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/avemujica/misumi-uika/",
      "global": "https://bdon.biligames.com/character/avemujica/misumi-uika/"
    },
  },
  {
    id: "avemujica/yutenji-nyamu",
    band: "avemujica",
    bandName: [
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica"
    ],
    slug: "yutenji-nyamu",
    role: "Dr.",
    name: [
      "アモーリス / 祐天寺 にゃむ",
      "Amoris / Nyamu Yūtenji",
      "Amoris /祐天寺若麥",
      "Amoris / 祐天寺若麦",
      "아모리스 / 유텐지 냐무"
    ],
    description: [
      "美容系を中心に発信する動画投稿者で、Ave Mujicaのドラマー。演技も学ぶ行動派。",
      "A beauty-focused video creator, acting student, and dynamic drummer for Ave Mujica.",
      "以美妝內容為主的影片創作者，也是學習表演的Ave Mujica鼓手。",
      "以美妆内容为主的视频创作者，也是学习表演的Ave Mujica鼓手。",
      "뷰티 영상을 주로 만드는 크리에이터이자 연기를 배우는 Ave Mujica의 드러머다."
    ],
    affiliation: [
      "芸術学院高校",
      "Geijutsu High School of Fine Arts",
      "藝術學院高中",
      "艺术学院高中",
      "예술학원고교"
    ],
    className: [
      "演劇表現科 1年",
      "Theater Department 1st Year",
      "戲劇表演科一年級",
      "戏剧表演系 1年级",
      "연극표현과 1학년"
    ],
    birthday: [
      "6月1日",
      "June 1",
      "6月1日",
      "6月1日",
      "6월 1일"
    ],
    favoriteFoods: [
      "辛いもの、スイカ、梨",
      "Spicy foods, watermelon, asian pear",
      "辛辣的食物、西瓜、水梨",
      "辛辣的食物、西瓜、梨",
      "매운 음식, 수박, 배"
    ],
    hobbies: [
      "コスメショッピング、プレゼントすること",
      "Beauty shopping, picking out gifts",
      "美妝購物、送禮",
      "美妆购物、送别人礼物",
      "화장품 쇼핑, 선물하기"
    ],
    castName: [
      "米澤 茜",
      "Akane Yonezawa",
      "米澤茜",
      "米泽茜",
      "요네자와 아카네"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yutenji-nyamu.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yutenji-nyamu_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/avemujica/yutenji-nyamu/",
      "global": "https://bdon.biligames.com/character/avemujica/yutenji-nyamu/"
    },
  },
  {
    id: "avemujica/wakaba-mutsumi",
    band: "avemujica",
    bandName: [
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica",
      "Ave Mujica"
    ],
    slug: "wakaba-mutsumi",
    role: "Gt.",
    name: [
      "モーティス / 若葉 睦",
      "Mortis / Mutsumi Wakaba",
      "Mortis /若葉睦",
      "Mortis / 若叶睦",
      "모르티스 / 와카바 무츠미"
    ],
    description: [
      "口数は少ないが思いやりを持つAve Mujicaのギタリスト。祥子の幼馴染で、幼少期からギターを弾く。",
      "Ave Mujica’s quiet yet considerate guitarist, Sakiko’s childhood friend and a player since childhood.",
      "沉默卻體貼的Ave Mujica吉他手，是祥子的青梅竹馬，自幼學習吉他。",
      "沉默却体贴的Ave Mujica吉他手，是祥子的青梅竹马，自幼学习吉他。",
      "말수는 적지만 배려심 있는 Ave Mujica의 기타리스트로, 사키코의 소꿉친구이며 어릴 때부터 기타를 쳤다."
    ],
    affiliation: [
      "月ノ森女子学園",
      "Tsukinomori Girls' Academy",
      "月之森女子學園",
      "月之森女子学园",
      "츠키노모리 여학원"
    ],
    className: [
      "1-A",
      "1-A",
      "1-A",
      "1-A",
      "1-A"
    ],
    birthday: [
      "1月14日",
      "January 14",
      "1月14日",
      "1月14日",
      "1월 14일"
    ],
    favoriteFoods: [
      "？？？",
      "？？？",
      "？？？",
      "？？？",
      "？？？"
    ],
    hobbies: [
      "？？？",
      "？？？",
      "？？？",
      "？？？",
      "？？？"
    ],
    castName: [
      "渡瀬 結月",
      "Yuzuki Watase",
      "渡瀨結月",
      "渡濑结月",
      "와타세 유즈키"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_wakaba-mutsumi.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_wakaba-mutsumi_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/avemujica/wakaba-mutsumi/",
      "global": "https://bdon.biligames.com/character/avemujica/wakaba-mutsumi/"
    },
  },
  {
    id: "yumemita/minetsuki-ritsu",
    band: "yumemita",
    bandName: [
      "夢限大みゅーたいぷ",
      "Mugendai MewType",
      "夢限大MewType",
      "梦限大MewType",
      "무겐다이 뮤타입"
    ],
    slug: "minetsuki-ritsu",
    role: "Gt.",
    name: [
      "峰月 律",
      "Ritsu Minetsuki",
      "峰月律",
      "峰月律",
      "미네츠키 리츠"
    ],
    description: [
      "真面目に音を支える夢限大みゅーたいぷのリズムギター。意外な行動と大きな食欲で周囲を驚かせる。",
      "Mugendai MewType’s diligent rhythm guitarist, known for surprising choices and a formidable appetite.",
      "認真支撐夢限大MewType聲響的節奏吉他手，偶爾以意外行動與驚人食量令人吃驚。",
      "认真支撑梦限大MewType声响的节奏吉他手，偶尔以意外行动和惊人食量令人吃惊。",
      "무겐다이 뮤타입의 성실한 리듬 기타로, 예상 밖의 행동과 엄청난 식욕으로 멤버들을 놀라게 한다."
    ],
    affiliation: [
      null,
      null,
      null,
      null,
      null
    ],
    className: [
      null,
      null,
      null,
      null,
      null
    ],
    birthday: [
      "2月7日",
      "February 7",
      "2月7日",
      "2月7日",
      "2월 7일"
    ],
    favoriteFoods: [
      "牛すき鍋、ラーメン",
      "Sukiyaki, ramen",
      "牛肉壽喜燒鍋、拉麵",
      "牛肉寿喜锅、拉面",
      "규스키나베, 라멘"
    ],
    hobbies: [
      "映画鑑賞",
      "Watching films",
      "電影欣賞",
      "电影鉴赏",
      "영화 감상"
    ],
    castName: [
      null,
      null,
      null,
      null,
      null
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_minetsuki-ritsu.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_minetsuki-ritsu_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/yumemita/minetsuki-ritsu/",
      "global": "https://bdon.biligames.com/character/yumemita/minetsuki-ritsu/"
    },
  },
  {
    id: "yumemita/sengoku-yuno",
    band: "yumemita",
    bandName: [
      "夢限大みゅーたいぷ",
      "Mugendai MewType",
      "夢限大MewType",
      "梦限大MewType",
      "무겐다이 뮤타입"
    ],
    slug: "sengoku-yuno",
    role: "DJ&Mp.",
    name: [
      "千石 ユノ",
      "Yuno Sengoku",
      "千石由乃",
      "千石由乃",
      "센고쿠 유노"
    ],
    description: [
      "演奏全体を操る夢限大みゅーたいぷのDJ＆マニピュレーター。淡々として見えるが情に厚い。",
      "Mugendai MewType’s homebody DJ and manipulator, cool in manner but warm at heart.",
      "掌控夢限大MewType整體演奏的DJ與操控手，外表冷淡，內心其實很重感情。",
      "掌控梦限大MewType整体演奏的DJ与操控手，外表冷淡，内心其实很重感情。",
      "무겐다이 뮤타입의 연주를 이끄는 DJ·매니퓰레이터로, 겉은 담담하지만 정이 깊다."
    ],
    affiliation: [
      null,
      null,
      null,
      null,
      null
    ],
    className: [
      null,
      null,
      null,
      null,
      null
    ],
    birthday: [
      "11月4日",
      "November 4",
      "11月4日",
      "11月4日",
      "11월 4일"
    ],
    favoriteFoods: [
      "ホワイトチョコ、エナジードリンク",
      "White chocolate, energy drinks",
      "白巧克力、能量飲料",
      "白巧克力、能量饮料",
      "화이트 초콜릿, 에너지 드링크"
    ],
    hobbies: [
      "ゲーム",
      "Video games",
      "電玩",
      "游戏",
      "게임"
    ],
    castName: [
      null,
      null,
      null,
      null,
      null
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_sengoku-yuno.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_sengoku-yuno_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/yumemita/sengoku-yuno/",
      "global": "https://bdon.biligames.com/character/yumemita/sengoku-yuno/"
    },
  },
  {
    id: "yumemita/nakamachi-arale",
    band: "yumemita",
    bandName: [
      "夢限大みゅーたいぷ",
      "Mugendai MewType",
      "夢限大MewType",
      "梦限大MewType",
      "무겐다이 뮤타입"
    ],
    slug: "nakamachi-arale",
    role: "Vo.",
    name: [
      "仲町 あられ",
      "Arale Nakamachi",
      "仲町阿拉蕾",
      "仲町阿拉蕾",
      "나카마치 아라레"
    ],
    description: [
      "歌と会話が大好きな夢限大みゅーたいぷのボーカル。力強い歌声と明るさでバンドを引っ張る。",
      "Mugendai MewType’s lively vocalist, leading the group with a powerful voice and love of conversation.",
      "熱愛唱歌與聊天的夢限大MewType主唱，以有力歌聲和開朗性格帶領樂團。",
      "热爱唱歌和聊天的梦限大MewType主唱，以有力歌声和开朗性格带领乐队。",
      "노래와 이야기를 좋아하는 무겐다이 뮤타입의 보컬로, 힘찬 목소리와 밝은 에너지로 밴드를 이끈다."
    ],
    affiliation: [
      null,
      null,
      null,
      null,
      null
    ],
    className: [
      null,
      null,
      null,
      null,
      null
    ],
    birthday: [
      "8月16日",
      "August 16",
      "8月16日",
      "8月16日",
      "8월 16일"
    ],
    favoriteFoods: [
      "メロンパンアイス、辛いもの",
      "Melon bun ice cream, spicy foods",
      "冰淇淋菠蘿麵包、辣的食物",
      "冰淇淋菠萝包、辣味食物",
      "멜론빵 아이스크림, 매운 음식"
    ],
    hobbies: [
      "漫画、アニメ",
      "Manga, anime",
      "漫畫、動畫",
      "漫画、动画",
      "만화, 애니메이션"
    ],
    castName: [
      null,
      null,
      null,
      null,
      null
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_nakamachi-arale.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_nakamachi-arale_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/yumemita/nakamachi-arale/",
      "global": "https://bdon.biligames.com/character/yumemita/nakamachi-arale/"
    },
  },
  {
    id: "yumemita/fuji-miyako",
    band: "yumemita",
    bandName: [
      "夢限大みゅーたいぷ",
      "Mugendai MewType",
      "夢限大MewType",
      "梦限大MewType",
      "무겐다이 뮤타입"
    ],
    slug: "fuji-miyako",
    role: "Key.",
    name: [
      "藤 都子",
      "Miyako Fuji",
      "藤都子",
      "藤都子",
      "후지 미야코"
    ],
    description: [
      "漫画家とバンド活動を両立する夢限大みゅーたいぷのキーボード。確かな技術と妥協しない姿勢を持つ。",
      "Mugendai MewType’s keyboardist and working manga artist, disciplined and uncompromising in her craft.",
      "兼任漫畫家的夢限大MewType鍵盤手，以扎實技術與不妥協的態度支撐樂團。",
      "兼任漫画家的梦限大MewType键盘手，以扎实技术和不妥协的态度支撑乐队。",
      "현역 만화가이자 무겐다이 뮤타입의 키보디스트로, 탄탄한 실력과 타협 없는 자세로 밴드를 받친다."
    ],
    affiliation: [
      null,
      null,
      null,
      null,
      null
    ],
    className: [
      null,
      null,
      null,
      null,
      null
    ],
    birthday: [
      "9月19日",
      "September 19",
      "9月19日",
      "9月19日",
      "9월 19일"
    ],
    favoriteFoods: [
      "ドーナツ、寿司",
      "Donuts, sushi",
      "甜甜圈、壽司",
      "甜甜圈、寿司",
      "도넛, 스시"
    ],
    hobbies: [
      "いけばな",
      "Ikebana",
      "插花",
      "插花",
      "꽃꽂이"
    ],
    castName: [
      null,
      null,
      null,
      null,
      null
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_fuji-miyako.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_fuji-miyako_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/yumemita/fuji-miyako/",
      "global": "https://bdon.biligames.com/character/yumemita/fuji-miyako/"
    },
  },
  {
    id: "yumemita/miyanaga-nonoka",
    band: "yumemita",
    bandName: [
      "夢限大みゅーたいぷ",
      "Mugendai MewType",
      "夢限大MewType",
      "梦限大MewType",
      "무겐다이 뮤타입"
    ],
    slug: "miyanaga-nonoka",
    role: "Gt.",
    name: [
      "宮永 ののか",
      "Nonoka Miyanaga",
      "宮永野乃花",
      "宫永野乃花",
      "미야나가 노노카"
    ],
    description: [
      "天真爛漫な夢限大みゅーたいぷのギタリスト。自ら音楽を楽しむ姿で観客まで巻き込むムードメーカー。",
      "Mugendai MewType’s carefree guitarist and mood-maker, drawing audiences in through her own joy in music.",
      "天真爛漫的夢限大MewType吉他手，以享受音樂的演出感染觀眾，是團內開心果。",
      "天真烂漫的梦限大MewType吉他手，以享受音乐的演出感染观众，是队内开心果。",
      "천진난만한 무겐다이 뮤타입의 기타리스트이자 분위기 메이커로, 음악을 즐기는 모습으로 관객을 끌어들인다."
    ],
    affiliation: [
      null,
      null,
      null,
      null,
      null
    ],
    className: [
      null,
      null,
      null,
      null,
      null
    ],
    birthday: [
      "4月17日",
      "April 17",
      "4月17日",
      "4月17日",
      "4월 17일"
    ],
    favoriteFoods: [
      "白いご飯、シチュー",
      "White rice, stew",
      "白米飯、燉菜",
      "白米饭、炖菜",
      "흰쌀밥, 스튜"
    ],
    hobbies: [
      "ボードゲーム",
      "Board games",
      "桌遊",
      "桌游",
      "보드게임"
    ],
    castName: [
      null,
      null,
      null,
      null,
      null
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_miyanaga-nonoka.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_miyanaga-nonoka_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/yumemita/miyanaga-nonoka/",
      "global": "https://bdon.biligames.com/character/yumemita/miyanaga-nonoka/"
    },
  },
  {
    id: "millsage/kotohira-nagi",
    band: "millsage",
    bandName: [
      "millsage",
      "millsage",
      "millsage",
      "millsage",
      "millsage"
    ],
    slug: "kotohira-nagi",
    role: "Gt.",
    name: [
      "琴平 凪",
      "Nagi Kotohira",
      "琴平凪",
      "琴平凪",
      "코토히라 나기"
    ],
    description: [
      "落ち着いた物腰で年齢以上に大人びて見えるmillsageのギタリスト。学校では密かな人気を集める。",
      "millsage’s calm, mature-seeming guitarist, quietly admired by fellow students at school.",
      "舉止沉穩、比實際年齡成熟的millsage吉他手，在校內也頗受仰慕。",
      "举止沉稳、比实际年龄成熟的millsage吉他手，在学校里也颇受仰慕。",
      "차분하고 나이보다 성숙해 보이는 millsage의 기타리스트로, 학교에서도 남몰래 인기가 많다."
    ],
    affiliation: [
      "水瀬女子学園",
      "Minase Girls' Academy",
      "水瀨女子學園",
      "水濑女子学园",
      "미나세 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "12月10日",
      "December 10",
      "12月10日",
      "12月10日",
      "12월 10일"
    ],
    favoriteFoods: [
      "ペロキャン",
      "Lollipop",
      "棒棒糖",
      "棒棒糖",
      "롤리팝"
    ],
    hobbies: [
      "読書、映画鑑賞",
      "Reading, watching movies",
      "閱讀、電影欣賞",
      "读书、电影鉴赏",
      "독서, 영화 감상"
    ],
    castName: [
      "結川 あさき",
      "Asaki Yuikawa",
      "結川麻希",
      "结川麻希",
      "유이카와 아사키"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_kotohira-nagi.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_kotohira-nagi_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/millsage/kotohira-nagi/",
      "global": "https://bdon.biligames.com/character/millsage/kotohira-nagi/"
    },
  },
  {
    id: "millsage/hamasaki-mahoro",
    band: "millsage",
    bandName: [
      "millsage",
      "millsage",
      "millsage",
      "millsage",
      "millsage"
    ],
    slug: "hamasaki-mahoro",
    role: "Ba.",
    name: [
      "浜崎 まほろ",
      "Mahoro Hamasaki",
      "濱崎茉幌",
      "滨崎茉幌",
      "하마사키 마호로"
    ],
    description: [
      "親しみやすいmillsageのまとめ役。自分たちで築いたバンドの日々を何より大切にしている。",
      "millsage’s friendly organizer, who treasures the band and the time its members have built together.",
      "親切隨和的millsage統籌者，格外珍惜成員共同建立的樂團與日常。",
      "亲切随和的millsage统筹者，格外珍惜成员共同建立的乐队与日常。",
      "붙임성 좋은 millsage의 중심 역할로, 멤버들이 함께 만든 밴드의 나날을 무엇보다 소중히 여긴다."
    ],
    affiliation: [
      "水瀬女子学園",
      "Minase Girls' Academy",
      "水瀨女子學園",
      "水濑女子学园",
      "미나세 여학원"
    ],
    className: [
      "2-A",
      "2-A",
      "2-A",
      "2-A",
      "2-A"
    ],
    birthday: [
      "7月16日",
      "July 16",
      "7月16日",
      "7月16日",
      "7월 16일"
    ],
    favoriteFoods: [
      "洋菓子、カレー",
      "Pastries, curry",
      "西點、咖哩",
      "西点、咖喱",
      "스위츠, 카레"
    ],
    hobbies: [
      "カメラ",
      "Photography",
      "攝影",
      "摄影",
      "사진 촬영"
    ],
    castName: [
      "伊駒 ゆりえ",
      "Yurie Igoma",
      "伊駒祐里惠",
      "伊驹祐里恵",
      "이고마 유리에"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_hamasaki-mahoro.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_hamasaki-mahoro_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/millsage/hamasaki-mahoro/",
      "global": "https://bdon.biligames.com/character/millsage/hamasaki-mahoro/"
    },
  },
  {
    id: "millsage/shiomi-hotaru",
    band: "millsage",
    bandName: [
      "millsage",
      "millsage",
      "millsage",
      "millsage",
      "millsage"
    ],
    slug: "shiomi-hotaru",
    role: "Key.&Vo.",
    name: [
      "汐見 蛍",
      "Hotaru Shiomi",
      "汐見螢",
      "汐见萤",
      "시오미 호타루"
    ],
    description: [
      "優しい心と卓越した音楽性を持つmillsageのキーボード＆ボーカル。感受性豊かだが世間知らずな面もある。",
      "millsage’s kind-hearted keyboardist-vocalist and musical prodigy, sensitive yet sometimes sheltered.",
      "心地善良、才華出眾的millsage鍵盤主唱，感情細膩，偶爾也有不諳世事的一面。",
      "心地善良、才华出众的millsage键盘主唱，感情细腻，偶尔也有不谙世事的一面。",
      "마음씨 착한 음악 천재이자 millsage의 키보드 보컬로, 감수성이 풍부하지만 세상 물정에 어두운 면도 있다."
    ],
    affiliation: [
      "芸術学院中学校",
      "Geijutsu Middle School of Fine Arts",
      "藝術學院中學",
      "艺术学院初中",
      "예술학원중학교"
    ],
    className: [
      "音楽科 3年",
      "Music Department, Year 3",
      "音樂科三年級",
      "音乐科 3年级",
      "음악과 3학년"
    ],
    birthday: [
      "3月12日",
      "March 12",
      "3月12日",
      "3月12日",
      "3월 12일"
    ],
    favoriteFoods: [
      "たまごボーロ",
      "Egg Boro Cookies",
      "小饅頭餅乾",
      "小馒头饼干",
      "계란과자"
    ],
    hobbies: [
      "ガーデニング",
      "Gardening",
      "園藝",
      "园艺",
      "가드닝"
    ],
    castName: [
      "薬師寺 李有",
      "Ria Yakushiji",
      "藥師寺李有",
      "药师寺李有",
      "야쿠시지 리아"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shiomi-hotaru.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shiomi-hotaru_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/millsage/shiomi-hotaru/",
      "global": "https://bdon.biligames.com/character/millsage/shiomi-hotaru/"
    },
  },
  {
    id: "millsage/izumi-houka",
    band: "millsage",
    bandName: [
      "millsage",
      "millsage",
      "millsage",
      "millsage",
      "millsage"
    ],
    slug: "izumi-houka",
    role: "Dr.",
    name: [
      "和泉 朋花",
      "Houka Izumi",
      "和泉朋花",
      "和泉朋花",
      "이즈미 호우카"
    ],
    description: [
      "可憐で社交的なmillsageのドラマー。茶目っ気もあり、突出した才能に強い関心を寄せる。",
      "millsage’s graceful, sociable drummer, playful in spirit and deeply interested in exceptional talent.",
      "優雅又善於社交的millsage鼓手，帶點俏皮，也對非凡才華充滿興趣。",
      "优雅又善于交际的millsage鼓手，带点俏皮，也对非凡才华充满兴趣。",
      "우아하고 사교적인 millsage의 드러머로, 장난기 있는 면과 뛰어난 재능에 대한 강한 관심을 지녔다."
    ],
    affiliation: [
      "水瀬女子学園",
      "Minase Girls' Academy",
      "水瀨女子學園",
      "水濑女子学园",
      "미나세 여학원"
    ],
    className: [
      "1-B",
      "1-B",
      "1-B",
      "1-B",
      "1-B"
    ],
    birthday: [
      "10月24日",
      "October 24",
      "10月24日",
      "10月24日",
      "10월 24일"
    ],
    favoriteFoods: [
      "和食、フレンチ",
      "Japanese cuisine, French cuisine",
      "和食、法式料理",
      "日料、法餐",
      "일식, 프렌치"
    ],
    hobbies: [
      "美食",
      "Gourmet",
      "美食",
      "美食",
      "미식"
    ],
    castName: [
      "咲川 ひなの",
      "Hinano Sakikawa",
      "咲川雛乃",
      "咲川雏乃",
      "사키카와 히나노"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_izumi-houka.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_izumi-houka_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/millsage/izumi-houka/",
      "global": "https://bdon.biligames.com/character/millsage/izumi-houka/"
    },
  },
  {
    id: "millsage/izawa-natsume",
    band: "millsage",
    bandName: [
      "millsage",
      "millsage",
      "millsage",
      "millsage",
      "millsage"
    ],
    slug: "izawa-natsume",
    role: "Gt.",
    name: [
      "伊沢 なつめ",
      "Natsume Izawa",
      "伊澤棗",
      "伊泽枣",
      "이자와 나츠메"
    ],
    description: [
      "自信家でプライドの高いmillsageの作曲担当兼ギタリスト。学校の屋上でギターを鳴らすことも多い。",
      "millsage’s proud, self-assured guitarist and composer, often found playing on the school rooftop.",
      "自信且自尊心強的millsage吉他手兼作曲者，也常在學校屋頂彈奏吉他。",
      "自信且自尊心强的millsage吉他手兼作曲者，也常在学校屋顶弹奏吉他。",
      "자신감과 자존심이 강한 millsage의 작곡 담당 기타리스트로, 학교 옥상에서 기타를 치곤 한다."
    ],
    affiliation: [
      "水瀬女子学園",
      "Minase Girls' Academy",
      "水瀨女子學園",
      "水濑女子学园",
      "미나세 여학원"
    ],
    className: [
      "2-B",
      "2-B",
      "2-B",
      "2-B",
      "2-B"
    ],
    birthday: [
      "3月30日",
      "March 30",
      "3月30日",
      "3月30日",
      "3월 30일"
    ],
    favoriteFoods: [
      "ホットスナック、硬水",
      "Grab-and-go, hard water",
      "熟食點心、硬水",
      "熟食小吃、硬水",
      "핫스낵, 센물"
    ],
    hobbies: [
      "古着屋巡り",
      "Vintage shop hopping",
      "逛古著店",
      "逛古着店",
      "빈티지샵 투어"
    ],
    castName: [
      "千春",
      "Chiharu",
      "千春",
      "千春",
      "치하루"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_izawa-natsume.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_izawa-natsume_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/millsage/izawa-natsume/",
      "global": "https://bdon.biligames.com/character/millsage/izawa-natsume/"
    },
  },
  {
    id: "ikka-dumb-rock/yakura-yomogi",
    band: "ikka-dumb-rock",
    bandName: [
      "一家Dumb Rock!",
      "Ikka Dumb Rock!",
      "一家Dumb Rock!",
      "一家Dumb Rock!",
      "일가 Dumb Rock!"
    ],
    slug: "yakura-yomogi",
    role: "Ba.",
    name: [
      "矢倉 蓬咲",
      "Yomogi Yakura",
      "矢倉蓬咲",
      "矢仓蓬咲",
      "야쿠라 요모기"
    ],
    description: [
      "人付き合いが苦手で寮にこもりがちな一家Dumb Rock!のベーシスト。心の中では不良漫画に憧れている。",
      "Ikka Dumb Rock!’s shy, reclusive bassist, secretly fascinated by delinquent manga heroes.",
      "不擅長與人相處、常待在宿舍的一家Dumb Rock!貝斯手，內心嚮往不良漫畫角色。",
      "不擅长与人相处、常待在宿舍的一家Dumb Rock!贝斯手，内心向往不良漫画角色。",
      "사람을 대하기 어려워 기숙사에 틀어박히기 쉬운 일가 Dumb Rock!의 베이시스트로, 속으로는 불량 만화 주인공을 동경한다."
    ],
    affiliation: [
      "新桜女子大学",
      "Shinō Women's University",
      "新櫻女子大學",
      "新樱女子大学",
      "신오 여자대학교"
    ],
    className: [
      "情報デザイン学部 デジタルイノベーション学科 1年",
      "First-year student majoring in Digital Innovation, Faculty of Information Design",
      "資訊設計學院 數位創新學科 一年級",
      "信息设计学院 电子创新学科 大一",
      "정보디자인학부 디지털이노베이션학과 1학년"
    ],
    birthday: [
      "5月6日",
      "May 6",
      "5月6日",
      "5月6日",
      "5월 6일"
    ],
    favoriteFoods: [
      "ぬれ煎餅、羊羹、激辛料理（好きになりたい）",
      "Soft senbei, yōkan, spicy foods (she wants to like them)",
      "濕煎餅、羊羹、激辛料理（希望可以喜歡）",
      "湿煎饼、羊羹、超辣料理（希望能喜欢上）",
      "촉촉한 전병, 양갱, 아주 매운 요리 (좋아하고 싶음)"
    ],
    hobbies: [
      "とある不良漫画のオタク",
      "An otaku of a certain delinquent manga",
      "某不良少年漫畫的宅粉",
      "某不良少年漫画的死忠粉",
      "어느 불량 만화의 오타쿠"
    ],
    castName: [
      "花宮 初奈",
      "Nina Hanamiya",
      "花宮初奈",
      "花宫初奈",
      "하나미야 니나"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yakura-yomogi.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_yakura-yomogi_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/ikka-dumb-rock/yakura-yomogi/",
      "global": "https://bdon.biligames.com/character/ikka-dumb-rock/yakura-yomogi/"
    },
  },
  {
    id: "ikka-dumb-rock/umezato-chieri",
    band: "ikka-dumb-rock",
    bandName: [
      "一家Dumb Rock!",
      "Ikka Dumb Rock!",
      "一家Dumb Rock!",
      "一家Dumb Rock!",
      "일가 Dumb Rock!"
    ],
    slug: "umezato-chieri",
    role: "Dr.",
    name: [
      "梅里 ちえり",
      "Chieri Umezato",
      "梅里千櫻梨",
      "梅里千樱梨",
      "우메자토 치에리"
    ],
    description: [
      "自己主張が強く反抗的だが憎めない一家Dumb Rock!のドラマー。失敗してもへこたれない元気さを持つ。",
      "Ikka Dumb Rock!’s loud, rebellious drummer, attention-seeking but resilient through every setback.",
      "愛表現又有些叛逆的一家Dumb Rock!鼓手，即使失敗也不會輕易氣餒。",
      "爱表现又有些叛逆的一家Dumb Rock!鼓手，即使失败也不会轻易气馁。",
      "자기주장이 강하고 반항적이지만 미워할 수 없는 일가 Dumb Rock!의 드러머로, 실패해도 쉽게 꺾이지 않는다."
    ],
    affiliation: [
      "羽丘女子学園",
      "Haneoka Girls' Academy",
      "羽丘女子學園",
      "羽丘女子学园",
      "하네오카 여학원"
    ],
    className: [
      "1-A",
      "1-A",
      "1-A",
      "1-A",
      "1-A"
    ],
    birthday: [
      "4月2日",
      "April 2",
      "4月2日",
      "4月2日",
      "4월 2일"
    ],
    favoriteFoods: [
      "肉",
      "Meat",
      "肉",
      "肉",
      "고기"
    ],
    hobbies: [
      "？？？",
      "？？？",
      "？？？",
      "？？？",
      "？？？"
    ],
    castName: [
      "菱川 花菜",
      "Hana Hishikawa",
      "菱川花菜",
      "菱川花菜",
      "히시카와 하나"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_umezato-chieri.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_umezato-chieri_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/ikka-dumb-rock/umezato-chieri/",
      "global": "https://bdon.biligames.com/character/ikka-dumb-rock/umezato-chieri/"
    },
  },
  {
    id: "ikka-dumb-rock/suga-raika",
    band: "ikka-dumb-rock",
    bandName: [
      "一家Dumb Rock!",
      "Ikka Dumb Rock!",
      "一家Dumb Rock!",
      "一家Dumb Rock!",
      "일가 Dumb Rock!"
    ],
    slug: "suga-raika",
    role: "Gt.&Vo.",
    name: [
      "須賀 蕾叶",
      "Raika Suga",
      "須賀蕾葉",
      "须贺蕾叶",
      "스가 라이카"
    ],
    description: [
      "明るく素直で、考えるより先に動く一家Dumb Rock!のギター＆ボーカル。人を尊重する一方、頑固さもある。",
      "Ikka Dumb Rock!’s upbeat guitarist-vocalist, quick to act and respectful of others, though sometimes stubborn.",
      "開朗直率、行動先於思考的一家Dumb Rock!吉他主唱；尊重他人，也有固執的一面。",
      "开朗直率、行动先于思考的一家Dumb Rock!吉他主唱；尊重他人，也有固执的一面。",
      "밝고 솔직하며 생각보다 행동이 빠른 일가 Dumb Rock!의 기타 보컬로, 타인을 존중하지만 고집스러운 면도 있다."
    ],
    affiliation: [
      "羽丘女子学園",
      "Haneoka Girls' Academy",
      "羽丘女子學園",
      "羽丘女子学园",
      "하네오카 여학원"
    ],
    className: [
      "2-A",
      "2-A",
      "2-A",
      "2-A",
      "2-A"
    ],
    birthday: [
      "7月28日",
      "July 28",
      "7月28日",
      "7月28日",
      "7월 28일"
    ],
    favoriteFoods: [
      "炊き立てご飯、鍋、焼肉やお好み焼きなどホットプレートでできるもの",
      "Freshly cooked rice, hot pot, yakiniku, okonomiyaki, and other hot plate dishes",
      "剛炊好的米飯、火鍋、燒肉或什錦燒等鐵板料理",
      "刚煮好的米饭、火锅、烤肉和御好烧等可以用电热板制作的食物",
      "갓 지은 밥, 전골, 구운 고기나 오코노미야키처럼 불판에 해 먹는 음식"
    ],
    hobbies: [
      "野球観戦",
      "Watching baseball",
      "看棒球比賽",
      "观看棒球比赛",
      "야구 관람"
    ],
    castName: [
      "橘 めい",
      "May Tachibana",
      "橘芽衣",
      "橘芽衣",
      "타치바나 메이"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_suga-raika.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_suga-raika_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/ikka-dumb-rock/suga-raika/",
      "global": "https://bdon.biligames.com/character/ikka-dumb-rock/suga-raika/"
    },
  },
  {
    id: "ikka-dumb-rock/shinomiya-shizuku",
    band: "ikka-dumb-rock",
    bandName: [
      "一家Dumb Rock!",
      "Ikka Dumb Rock!",
      "一家Dumb Rock!",
      "一家Dumb Rock!",
      "일가 Dumb Rock!"
    ],
    slug: "shinomiya-shizuku",
    role: "Key.",
    name: [
      "四宮 寧月",
      "Shizuku Shinomiya",
      "四宮寧月",
      "四宫宁月",
      "시노미야 시즈쿠"
    ],
    description: [
      "年齢以上に落ち着いた一家Dumb Rock!最年少のキーボード。謎めいた価値観と卓越したピアノ技術を持つ。",
      "Ikka Dumb Rock!’s enigmatic youngest keyboardist, unusually composed and exceptionally skilled at piano.",
      "一家Dumb Rock!神祕的年少鍵盤手，異常沉著，並擁有卓越的鋼琴技術。",
      "一家Dumb Rock!神秘的年少键盘手，异常沉着，并拥有卓越的钢琴技术。",
      "나이에 비해 침착한 일가 Dumb Rock!의 수수께끼 많은 막내 키보디스트로, 피아노 실력이 뛰어나다."
    ],
    affiliation: [
      "月ノ森女子学園 中等部",
      "Tsukinomori Girls' Academy, Middle School",
      "月之森女子學園 國中部",
      "月之森女子学园 初中部",
      "츠키노모리 여학원 중등부"
    ],
    className: [
      "2-C",
      "2-C",
      "2-C",
      "2-C",
      "2-C"
    ],
    birthday: [
      "3月5日",
      "March 5",
      "3月5日",
      "3月5日",
      "3월 5일"
    ],
    favoriteFoods: [
      "なし",
      "N/A",
      "無",
      "无",
      "없음"
    ],
    hobbies: [
      "なし",
      "N/A",
      "無",
      "无",
      "없음"
    ],
    castName: [
      "遠野 ひかる",
      "Hikaru Tono",
      "遠野光",
      "远野光",
      "토오노 히카루"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shinomiya-shizuku.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_shinomiya-shizuku_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/ikka-dumb-rock/shinomiya-shizuku/",
      "global": "https://bdon.biligames.com/character/ikka-dumb-rock/shinomiya-shizuku/"
    },
  },
  {
    id: "ikka-dumb-rock/mahashi-miku",
    band: "ikka-dumb-rock",
    bandName: [
      "一家Dumb Rock!",
      "Ikka Dumb Rock!",
      "一家Dumb Rock!",
      "一家Dumb Rock!",
      "일가 Dumb Rock!"
    ],
    slug: "mahashi-miku",
    role: "Gt.&Vo.",
    name: [
      "馬橋 心玖",
      "Miku Mahashi",
      "馬橋心玖",
      "马桥心玖",
      "마하시 미쿠"
    ],
    description: [
      "柔和で現実的な一家Dumb Rock!のギター＆ボーカル。人との距離を慎重に保ち、信頼するまで本音を隠す。",
      "Ikka Dumb Rock!’s gentle, pragmatic guitarist-vocalist, careful with boundaries and slow to reveal her true feelings.",
      "溫和務實的一家Dumb Rock!吉他主唱，謹慎維持人際界線，建立信任後才會坦露真心。",
      "温和务实的一家Dumb Rock!吉他主唱，谨慎维持人际界限，建立信任后才会坦露真心。",
      "온화하고 현실적인 일가 Dumb Rock!의 기타 보컬로, 관계의 거리를 신중히 지키며 믿기 전까지 속마음을 감춘다."
    ],
    affiliation: [
      "花咲川女子学園",
      "Hanasakigawa Girls' Academy",
      "花咲川女子學園",
      "花咲川女子学园",
      "하나사키가와 여학원"
    ],
    className: [
      "2-B",
      "2-B",
      "2-B",
      "2-B",
      "2-B"
    ],
    birthday: [
      "10月4日",
      "October 4",
      "10月4日",
      "10月4日",
      "10월 4일"
    ],
    favoriteFoods: [
      "フルーツタルト",
      "Fruit tart",
      "水果塔",
      "水果挞",
      "과일 타르트"
    ],
    hobbies: [
      "？？？",
      "？？？",
      "？？？",
      "？？？",
      "？？？"
    ],
    castName: [
      "涼泉 桜花",
      "Sakura Suzumi",
      "涼泉櫻花",
      "凉泉樱花",
      "스즈미 사쿠라"
    ],
    images: [
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_mahashi-miku.webp",
      "https://bang-dream-on.bushimo.jp/wordpress/wp-content/themes/bang-dream-on_prod/assets/images/common/character/img_mahashi-miku_2.webp"
    ],
    sources: {
      "ja": "https://bang-dream-on.bushimo.jp/character/ikka-dumb-rock/mahashi-miku/",
      "global": "https://bdon.biligames.com/character/ikka-dumb-rock/mahashi-miku/"
    },
  },
] as const satisfies readonly CharacterProfile[];
