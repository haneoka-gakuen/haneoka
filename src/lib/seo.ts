import { localeTag, type Locale } from "../i18n/locales";
import { PRIMARY_DESTINATIONS, isDestinationActive } from "../config/navigation";
import { t } from "../i18n/messages";

const PRIVATE_ROUTES = new Set([
  "/account",
  "/account/reset-password",
  "/settings",
  "/community",
  "/community/mine",
  "/community/bookmarks",
  "/community/notifications",
  "/community/activity",
  "/community/posts/new",
]);

export function canonicalPath(route: string): string {
  const clean = `/${route.replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? "/" : `${clean}/`;
}

export function shouldNoindex(route: string): boolean {
  const path = canonicalPath(route).replace(/\/$/, "") || "/";
  return PRIVATE_ROUTES.has(path) || path === "/admin" || path.startsWith("/admin/");
}

export function pageStructuredData(origin: string, route: string, locale: Locale, name: string, description: string) {
  const home = `${origin}/`;
  const url = `${origin}${canonicalPath(route)}`;
  const website = {
    "@type": "WebSite",
    "@id": `${home}#website`,
    url: home,
    name: "haneoka",
    alternateName: "Haneoka",
  };
  const page = {
    "@type": "WebPage",
    "@id": `${url}#page`,
    url,
    name,
    description,
    inLanguage: localeTag(locale),
    isPartOf: { "@id": website["@id"] },
  };
  if (route === "/") return { "@context": "https://schema.org", "@graph": [website, page] };
  const parent = PRIMARY_DESTINATIONS.find((destination) => isDestinationActive(destination, route));
  const trail = [
    { name: "haneoka", item: home },
    ...(parent && parent.route !== "/" && canonicalPath(parent.route) !== canonicalPath(route)
      ? [{ name: t(locale, parent.label, parent.id), item: `${origin}${canonicalPath(parent.route)}` }]
      : []),
    { name: name.replace(/ · haneoka$/, ""), item: url },
  ];
  return {
    "@context": "https://schema.org",
    "@graph": [
      page,
      {
        "@type": "BreadcrumbList",
        "@id": `${url}#breadcrumb`,
        itemListElement: trail.map((item, index) => ({ "@type": "ListItem", position: index + 1, ...item })),
      },
    ],
  };
}

const COPY: Record<
  Locale,
  {
    home: string;
    catalog: string;
    catalogItem: (title: string) => string;
    about: string;
    community: string;
    communityTags: string;
    communityPlaylists: string;
    communitySongs: string;
    communityStories: string;
    terms: string;
    privacy: string;
    general: (title: string) => string;
  }
> = {
  ja: {
    home: "BanG Dream! Our Notes の非公式資料アーカイブ。楽曲、メンバー、カード、キャラクター、ストーリー、イベントの資料を整理し、ブラウザーで閲覧できます。",
    catalog:
      "BanG Dream! Our Notes の楽曲、メンバー、カード、キャラクター、ストーリーなどをまとめた非公式資料アーカイブです。",
    catalogItem: (title) => `${title}のデータと関連項目を確認できます。BanG Dream! Our Notes 資料アーカイブ。`,
    about:
      "haneoka は BanG Dream! Our Notes の資料を整理し、ブラウザーで閲覧するためのコミュニティ運営の非公式プロジェクトです。",
    community: "BanG Dream! Our Notes のコミュニティ投稿を閲覧できます。",
    communityTags: "BanG Dream! Our Notes コミュニティで使われているタグを閲覧できます。",
    communityPlaylists: "BanG Dream! Our Notes コミュニティのプレイリストを閲覧できます。",
    communitySongs: "BanG Dream! Girls Band Party! の楽曲情報を閲覧できます。",
    communityStories: "GBP のイベント、バンド、メイン、エリア会話、カードストーリーを閲覧できます。",
    terms: "haneoka の利用条件と、サイトおよびコミュニティ機能を利用する際のルールを確認できます。",
    privacy: "haneoka が取り扱う情報、Cookie、アカウント情報、およびプライバシーに関する方針を確認できます。",
    general: (title) => `BanG Dream! Our Notes の非公式資料アーカイブ、haneoka の${title}ページです。`,
  },
  en: {
    home: "An unofficial BanG Dream! Our Notes archive maintained by the community. Browse songs, members, cards, characters, stories, and event data.",
    catalog:
      "Browse the community-maintained, unofficial BanG Dream! Our Notes archive, including songs, members, cards, characters, and stories.",
    catalogItem: (title) => `${title}: game data and related entries from BanG Dream! Our Notes.`,
    about:
      "Haneoka is a community-maintained, unofficial project for organizing and browsing BanG Dream! Our Notes reference data.",
    community: "Browse community posts related to BanG Dream! Our Notes.",
    communityTags: "Browse tags used in the BanG Dream! Our Notes community.",
    communityPlaylists: "Browse playlists shared by the BanG Dream! Our Notes community.",
    communitySongs: "Browse song information from BanG Dream! Girls Band Party!.",
    communityStories: "Browse GBP event, band, main, area conversation, and card stories.",
    terms: "Read the terms and rules for using haneoka and its community features.",
    privacy: "Read how haneoka handles account information, cookies, and other data.",
    general: (title) => `${title} in the community-maintained, unofficial BanG Dream! Our Notes archive, haneoka.`,
  },
  "zh-TW": {
    home: "由社群維護的 BanG Dream! Our Notes 非官方資料典藏。整理樂曲、團員、卡片、角色、故事與活動資料，並提供瀏覽器檢視。",
    catalog: "瀏覽 BanG Dream! Our Notes 非官方資料典藏，內容包括樂曲、團員、卡片、角色與故事。",
    catalogItem: (title) => `${title}的資料與相關條目。BanG Dream! Our Notes 資料查詢。`,
    about: "haneoka 是由社群維護、用於整理及瀏覽 BanG Dream! Our Notes 參考資料的非官方專案。",
    community: "瀏覽 BanG Dream! Our Notes 相關的社群貼文。",
    communityTags: "瀏覽 BanG Dream! Our Notes 社群使用的標籤。",
    communityPlaylists: "瀏覽 BanG Dream! Our Notes 社群分享的播放清單。",
    communitySongs: "瀏覽 BanG Dream! Girls Band Party! 的樂曲資料。",
    communityStories: "瀏覽 GBP 活動、樂團、主線、區域對話與卡片故事。",
    terms: "查看 haneoka 及其社群功能的使用條款與規則。",
    privacy: "查看 haneoka 對帳戶資訊、Cookie 與其他資料的處理方式。",
    general: (title) => `haneoka 的${title}頁面，收錄於社群維護的 BanG Dream! Our Notes 非官方資料典藏。`,
  },
  "zh-CN": {
    home: "由社区维护的 BanG Dream! Our Notes 非官方资料归档，整理歌曲、成员、卡牌、角色、故事和活动资料，并提供浏览器查看。",
    catalog: "浏览 BanG Dream! Our Notes 非官方资料库，内容包括歌曲、成员、卡牌、角色和故事。",
    catalogItem: (title) => `${title}的数据与相关条目。BanG Dream! Our Notes 资料查询。`,
    about: "haneoka 是由社区维护、用于整理和浏览 BanG Dream! Our Notes 参考资料的非官方项目。",
    community: "浏览 BanG Dream! Our Notes 相关的社区帖子。",
    communityTags: "浏览 BanG Dream! Our Notes 社区使用的标签。",
    communityPlaylists: "浏览 BanG Dream! Our Notes 社区分享的播放列表。",
    communitySongs: "浏览 BanG Dream! Girls Band Party! 的歌曲资料。",
    communityStories: "浏览 GBP 活动、乐队、主线、区域对话和卡牌故事。",
    terms: "查看 haneoka 及其社区功能的使用条款和规则。",
    privacy: "查看 haneoka 对账户信息、Cookie 和其他数据的处理方式。",
    general: (title) => `haneoka 的${title}页面，收录于社区维护的 BanG Dream! Our Notes 非官方资料库。`,
  },
  ko: {
    home: "커뮤니티가 운영하는 BanG Dream! Our Notes 비공식 자료 아카이브입니다. 곡, 멤버, 카드, 캐릭터, 스토리와 이벤트 자료를 정리해 브라우저에서 볼 수 있습니다.",
    catalog: "곡, 멤버, 카드, 캐릭터와 스토리를 포함한 BanG Dream! Our Notes 비공식 자료 아카이브를 둘러보세요.",
    catalogItem: (title) => `BanG Dream! Our Notes의 ${title} 데이터와 관련 항목을 확인하세요.`,
    about:
      "haneoka는 BanG Dream! Our Notes 참고 자료를 정리하고 브라우저에서 볼 수 있도록 커뮤니티가 운영하는 비공식 프로젝트입니다.",
    community: "BanG Dream! Our Notes 관련 커뮤니티 게시물을 둘러보세요.",
    communityTags: "BanG Dream! Our Notes 커뮤니티에서 사용하는 태그를 둘러보세요.",
    communityPlaylists: "BanG Dream! Our Notes 커뮤니티가 공유한 플레이리스트를 둘러보세요.",
    communitySongs: "BanG Dream! Girls Band Party! 곡 정보를 둘러보세요.",
    communityStories: "GBP 이벤트, 밴드, 메인, 에어리어 대화와 카드 스토리를 둘러보세요.",
    terms: "haneoka와 커뮤니티 기능 이용에 관한 약관과 규칙을 확인하세요.",
    privacy: "haneoka의 계정 정보, 쿠키 및 기타 데이터 처리 방식을 확인하세요.",
    general: (title) =>
      `커뮤니티가 운영하는 BanG Dream! Our Notes 비공식 자료 아카이브 haneoka의 ${title} 페이지입니다.`,
  },
};

const RESOURCE_COPY: Record<string, Record<Locale, string>> = {
  "/catalog/songs": {
    ja: "BanG Dream! Our Notes の楽曲クレジット、譜面難易度、ノーツ数と公開情報。",
    en: "Song credits, chart difficulties, note counts, and release details for BanG Dream! Our Notes.",
    "zh-TW": "BanG Dream! Our Notes 樂曲的製作名單、譜面難度、音符數與發布資訊。",
    "zh-CN": "BanG Dream! Our Notes 乐曲的制作信息、谱面难度、音符数量与发布信息。",
    ko: "BanG Dream! Our Notes 곡의 제작진, 채보 난이도, 노트 수와 공개 정보.",
  },
  "/catalog/characters": {
    ja: "BanG Dream! Our Notes のキャラクター立ち絵、プロフィール、所属バンド、カードと関連ストーリー。",
    en: "Character portraits, profiles, bands, cards, and related stories from BanG Dream! Our Notes.",
    "zh-TW": "BanG Dream! Our Notes 角色立繪、個人資料、所屬樂團、卡片與相關故事。",
    "zh-CN": "BanG Dream! Our Notes 角色立绘、个人资料、所属乐队、卡牌与相关故事。",
    ko: "BanG Dream! Our Notes 캐릭터 일러스트, 프로필, 소속 밴드, 카드와 관련 스토리.",
  },
  "/catalog/member-cards": {
    ja: "メンバーカードの能力、スキル、育成段階と各段階に必要な素材。",
    en: "Member card stats, skills, progression stages, and materials required for each upgrade.",
    "zh-TW": "成員卡的能力、技能、培養階段與各階段所需素材。",
    "zh-CN": "成员卡的能力、技能、培养阶段与每一级所需材料。",
    ko: "멤버 카드의 능력치, 스킬, 육성 단계와 단계별 필요 재료.",
  },
  "/catalog/support-cards": {
    ja: "サポートカードの能力、スキル、ランクと育成情報。",
    en: "Support card stats, skills, ranks, and progression details.",
    "zh-TW": "留影卡的能力、技能、等級與培養資訊。",
    "zh-CN": "留影卡的能力、技能、等级与培养信息。",
    ko: "서포트 카드의 능력치, 스킬, 랭크와 육성 정보.",
  },
  "/catalog/band-items": {
    ja: "バンドアイテムの効果とレベルごとの強化素材。",
    en: "Band item effects and materials required for each upgrade level.",
    "zh-TW": "樂團道具的效果與各等級強化所需素材。",
    "zh-CN": "乐队道具的效果与各等级升级所需材料。",
    ko: "밴드 아이템의 효과와 레벨별 강화 재료.",
  },
  "/catalog/live2d": {
    ja: "Live2D モデルのプレビュー、モーション、表情、パラメーターと画像出力。",
    en: "Preview Live2D models, switch motions and expressions, adjust parameters, and export images.",
    "zh-TW": "預覽 Live2D 模型、切換動作與表情、調整參數並匯出圖片。",
    "zh-CN": "预览 Live2D 模型、切换动作与表情、调整参数并导出图片。",
    ko: "Live2D 모델 미리보기, 모션과 표정 전환, 파라미터 조정 및 이미지 내보내기.",
  },
  "/catalog/spine": {
    ja: "Spine モデルの一覧、アニメーションプレビューと透過 PNG 出力。",
    en: "Browse Spine models, preview animations, and export transparent PNG images.",
    "zh-TW": "Spine 模型目錄、動畫預覽與透明 PNG 圖片匯出。",
    "zh-CN": "Spine 模型目录、动画预览与透明 PNG 图片导出。",
    ko: "Spine 모델 목록, 애니메이션 미리보기 및 투명 PNG 이미지 내보내기.",
  },
};

export function pageDescription(locale: Locale, route: string, title: string): string {
  const resource = RESOURCE_COPY[route]?.[locale];
  if (resource) return resource;
  const copy = COPY[locale];
  if (route === "/") return copy.home.trim();
  if (route === "/catalog") return copy.catalog;
  if (route.startsWith("/catalog/")) return copy.catalogItem(title);
  if (route === "/about") return copy.about;
  if (route === "/community/tags") return copy.communityTags;
  if (route === "/community/playlists") return copy.communityPlaylists;
  if (route === "/community/songs-bestdori") return copy.communitySongs;
  if (route.startsWith("/community/stories-bestdori/")) return copy.communityStories;
  if (route.startsWith("/community")) return copy.community;
  if (route === "/terms") return copy.terms;
  if (route === "/privacy") return copy.privacy;
  return copy.general(title);
}
