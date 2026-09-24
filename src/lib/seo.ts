import type { Locale } from "../i18n/locales";

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
  return PRIVATE_ROUTES.has(route) || route === "/admin" || route.startsWith("/admin/");
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
    catalogItem: (title) => `BanG Dream! Our Notes の非公式資料アーカイブで、${title}の一覧と関連情報を閲覧できます。`,
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
    catalogItem: (title) =>
      `Browse ${title} and related game data in the community-maintained, unofficial BanG Dream! Our Notes archive.`,
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
    catalogItem: (title) => `在社群維護的 BanG Dream! Our Notes 非官方資料典藏中瀏覽${title}與相關遊戲資料。`,
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
    catalogItem: (title) => `在社区维护的 BanG Dream! Our Notes 非官方资料库中浏览${title}及相关游戏资料。`,
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
    catalogItem: (title) =>
      `커뮤니티가 운영하는 BanG Dream! Our Notes 비공식 자료 아카이브에서 ${title} 및 관련 게임 자료를 볼 수 있습니다.`,
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

export function pageDescription(locale: Locale, route: string, title: string): string {
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
