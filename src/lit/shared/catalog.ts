import { readReleaseServer } from "../../lib/release-server";
export type JsonRecord = Record<string, unknown>;
export const UI_LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
export function preferredLocale(fallback = "ja"): string {
  let stored = "";
  try {
    stored = localStorage.getItem("haneoka.locale") || "";
  } catch {
    // The document bootstrap remains authoritative when storage is unavailable.
  }
  const value = document.documentElement.dataset.locale || stored || fallback;
  return (UI_LOCALES as readonly string[]).includes(value) ? value : fallback;
}
const UI_COPY: Record<string, readonly [string, string, string, string, string]> = {
  voice: ["ボイス", "Voice", "語音", "语音", "음성"],
  illustration: ["イラスト", "Illustration", "插圖", "插图", "일러스트"],
  playVoice: ["ボイスを再生", "Play voice", "播放語音", "播放语音", "음성 재생"],
  conversation: ["トーク", "Conversation", "聊天", "聊天", "대화"],
  choices: ["選択肢", "Choices", "選項", "选项", "선택지"],
  stamp: ["スタンプ", "Sticker", "貼圖", "贴图", "스티커"],
  video: ["動画", "Video", "影片", "视频", "동영상"],
  musicPlayer: ["ミュージックプレーヤー", "Music player", "音樂播放器", "音乐播放器", "음악 플레이어"],
  queue: ["再生キュー", "Queue", "播放佇列", "播放队列", "재생 대기열"],
  clearQueue: ["キューを消去", "Clear queue", "清空佇列", "清空队列", "대기열 비우기"],
  playbackPosition: ["再生位置", "Playback position", "播放位置", "播放位置", "재생 위치"],
  volume: ["音量", "Volume", "音量", "音量", "볼륨"],
  mute: ["ミュート", "Mute", "靜音", "静音", "음소거"],
  unmute: ["ミュート解除", "Unmute", "取消靜音", "取消静音", "음소거 해제"],
  collapse: ["折りたたむ", "Collapse", "收合", "收起", "접기"],
  expandPlayer: ["プレーヤーを開く", "Expand player", "展開播放器", "展开播放器", "플레이어 펼치기"],
  reorder: ["並べ替える", "Reorder", "調整順序", "调整顺序", "순서 변경"],
  playInOrder: ["順番に再生", "Play in order", "順序播放", "顺序播放", "순서대로 재생"],
  repeatQueue: ["全曲リピート", "Repeat queue", "清單循環", "列表循环", "전체 반복"],
  repeatTrack: ["1曲リピート", "Repeat track", "單曲循環", "单曲循环", "한 곡 반복"],
  shuffle: ["シャッフル", "Shuffle", "隨機播放", "随机播放", "셔플"],
  filter: ["フィルター", "Filter", "篩選", "筛选", "필터"],
  searchStories: ["ストーリーを検索", "Search stories", "搜尋故事", "搜索故事", "스토리 검색"],
  searchHelp: ["ヘルプを検索", "Search help", "搜尋幫助", "搜索帮助", "도움말 검색"],
  searchAnon: ["ANON TOKYOを検索", "Search ANON TOKYO", "搜尋 ANON TOKYO", "搜索 ANON TOKYO", "ANON TOKYO 검색"],
  bands: ["バンド", "Bands", "樂團", "乐队", "밴드"],
  characters: ["キャラクター", "Characters", "角色", "角色", "캐릭터"],
  firstCharacter: ["1人目", "First character", "第一位角色", "第一位角色", "첫 번째 캐릭터"],
  secondCharacter: ["2人目", "Second character", "第二位角色", "第二位角色", "두 번째 캐릭터"],
  character: ["キャラクター", "Character", "角色", "角色", "캐릭터"],
  sort: ["並び替え", "Sort", "排序", "排序", "정렬"],
  release: ["公開日", "Release", "公開日期", "发布日期", "공개일"],
  title: ["タイトル", "Title", "標題", "标题", "제목"],
  duration: ["長さ", "Duration", "長度", "时长", "길이"],
  friendship: ["キズナレベル", "Friendship", "羈絆等級", "羁绊等级", "인연 레벨"],
  openStory: ["ストーリーを開く", "Open story", "開啟故事", "打开故事", "스토리 열기"],
  playStory: ["ストーリーを再生", "Play story", "播放故事", "播放故事", "스토리 재생"],
  manual: ["ヘルプ", "Manual", "幫助", "帮助", "도움말"],
  loadingTips: ["ロード中のヒント", "Loading tips", "載入提示", "加载提示", "로딩 팁"],
  motion: ["モーション", "Motion", "動作", "动作", "모션"],
  expression: ["表情", "Expression", "表情", "表情", "표정"],
  swap: ["入れ替え", "Swap", "交換", "交换", "교체"],
  chapter: ["チャプター", "Chapter", "章節", "章节", "챕터"],
  chapters: ["チャプター", "Chapters", "章節", "章节", "챕터"],
  anotherStory: ["アナザーストーリー", "Another Story", "番外故事", "番外故事", "어나더 스토리"],
  exStory: ["EXストーリー", "EX Story", "EX 剧情", "EX 剧情", "EX 스토리"],
  selectModel: [
    "ライブラリからモデルを選択",
    "Select a model from the library",
    "從模型庫選擇模型",
    "从模型库选择模型",
    "라이브러리에서 모델 선택",
  ],
  search: ["検索", "Search", "搜尋", "搜索", "검색"],
  loading: ["読み込み中", "Loading", "載入中", "加载中", "불러오는 중"],
  view: ["表示", "View", "顯示", "显示", "표시"],
  density: ["表示密度", "Density", "顯示密度", "显示密度", "표시 밀도"],
  comfortable: ["標準", "Comfortable", "標準", "标准", "표준"],
  compact: ["高密度", "Compact", "高密度", "高密度", "고밀도"],
  remove: ["削除", "Remove", "移除", "移除", "제거"],
  empty: ["該当なし", "No results", "沒有結果", "没有结果", "결과 없음"],
  play: ["再生", "Play", "播放", "播放", "재생"],
  pause: ["一時停止", "Pause", "暫停", "暂停", "일시 정지"],
  player: ["プレーヤー", "Player", "播放器", "播放器", "플레이어"],
  storyText: ["テキスト", "Text", "文字", "文字", "텍스트"],
  autoplay: ["オート", "Auto", "自動播放", "自动播放", "자동 재생"],
  settings: ["設定", "Settings", "設定", "设置", "설정"],
  previous: ["前へ", "Previous", "上一句", "上一句", "이전"],
  next: ["次へ", "Next", "下一句", "下一句", "다음"],
  screenshot: ["スクリーンショット", "Screenshot", "螢幕截圖", "截图", "스크린샷"],
  replay: ["もう一度", "Replay", "重播", "重播", "다시 재생"],
  parameters: ["パラメータ", "Parameters", "參數", "参数", "파라미터"],
  transform: ["表示調整", "Transform", "顯示調整", "显示调整", "표시 조정"],
  scale: ["拡大率", "Scale", "縮放", "缩放", "크기"],
  horizontal: ["横位置", "Horizontal", "水平位置", "水平位置", "가로 위치"],
  vertical: ["縦位置", "Vertical", "垂直位置", "垂直位置", "세로 위치"],
  progress: ["進行", "Progress", "進度", "进度", "진행"],
  details: ["詳細", "Details", "詳情", "详情", "상세"],
  reset: ["リセット", "Reset", "重設", "重置", "초기화"],
  type: ["タイプ", "Type", "類型", "类型", "유형"],
  band: ["バンド", "Band", "樂團", "乐队", "밴드"],
  model: ["モデル", "Model", "模型", "模型", "모델"],
  family: ["ファミリー", "Family", "系列", "系列", "계열"],
  version: ["バージョン", "Version", "版本", "版本", "버전"],
  animations: ["アニメーション", "Animations", "動畫", "动画", "애니메이션"],
  visualAssets: ["ビジュアル素材", "Visual assets", "視覺素材", "视觉素材", "비주얼 에셋"],
  loadMore: ["さらに読み込む", "Load more", "載入更多", "加载更多", "더 보기"],
  all: ["すべて", "All", "全部", "全部", "전체"],
  story: ["ストーリー", "Story", "故事", "故事", "스토리"],
  live: ["ライブ", "Live", "演出", "演出", "라이브"],
  order: ["表示順", "Order", "顯示順序", "显示顺序", "표시 순서"],
  ascending: ["昇順", "Ascending", "升冪", "升序", "오름차순"],
  descending: ["降順", "Descending", "降冪", "降序", "내림차순"],
  minimum: ["最小", "Minimum", "最小", "最小", "최소"],
  maximum: ["最大", "Maximum", "最大", "最大", "최대"],
  availableAudio: ["音声あり", "Playable audio", "可播放音訊", "可播放音频", "재생 가능한 오디오"],
  availableImage: ["画像あり", "Artwork", "圖片", "图片", "이미지"],
  yes: ["あり", "Yes", "有", "有", "있음"],
  no: ["なし", "No", "無", "无", "없음"],
  quality: ["品質", "Quality", "品質", "品质", "품질"],
  costumeId: ["衣装", "Costume", "服裝", "服装", "의상"],
  subCharacter: ["サブキャラクター", "Supporting character", "配角", "配角", "서브 캐릭터"],
  preview: ["プレビュー画像", "Preview image", "預覽圖", "预览图", "미리보기"],
  fullscreen: ["全画面", "Full screen", "全螢幕", "全屏", "전체 화면"],
  table: ["表", "Table", "表格", "表格", "표"],
  bandStory: ["バンドストーリー", "Band story", "樂團故事", "乐队故事", "밴드 스토리"],
  extraStory: ["Extra", "Extra", "Extra", "Extra", "Extra"],
  perspectiveCharacter: ["視点のキャラクター", "Viewpoint character", "視角角色", "视角角色", "시점 캐릭터"],
  perspectiveStory: ["視点ストーリー", "Perspective story", "視角故事", "视角故事", "시점 스토리"],
  grid: ["グリッド", "Grid", "網格", "网格", "그리드"],
  list: ["リスト", "List", "列表", "列表", "목록"],
  close: ["閉じる", "Close", "關閉", "关闭", "닫기"],
  breath: ["呼吸", "Breath", "呼吸", "呼吸", "호흡"],
  blink: ["まばたき", "Blink", "眨眼", "眨眼", "눈 깜빡임"],
  sway: ["視線追従", "Sway", "視線跟隨", "视线跟随", "시선 추적"],
  background: ["背景", "Background", "背景", "背景", "배경"],
  parameterMode: ["パラメータモード", "Parameter mode", "參數模式", "参数模式", "파라미터 모드"],
  none: ["なし", "None", "無", "无", "없음"],
  capture: ["キャプチャ", "Capture", "擷取", "捕获", "캡처"],
  pose: ["ポーズ", "Pose", "姿勢", "姿势", "포즈"],
  import: ["インポート", "Import", "匯入", "导入", "가져오기"],
  export: ["エクスポート", "Export", "匯出", "导出", "내보내기"],
  loop: ["ループ", "Loop", "循環", "循环", "반복"],
  part: ["パート", "Part", "分工", "分工", "파트"],
  school: ["学校", "School", "學校", "学校", "학교"],
  headwear: ["頭飾り", "Headwear", "頭飾", "头饰", "머리 장식"],
  top: ["トップス", "Top", "上裝", "上装", "상의"],
  bottom: ["ボトムス", "Bottom", "下裝", "下装", "하의"],
  shoes: ["靴", "Shoes", "鞋", "鞋", "신발"],
  set: ["セット", "Set", "套裝", "套装", "세트"],
  defaultOutfit: ["デフォルト衣装", "Default outfit", "預設服裝", "默认服装", "기본 의상"],
  playerLevels: ["プレイヤーレベル", "Player levels", "玩家等級", "玩家等级", "플레이어 레벨"],
  expansion: ["拡張", "Expansion", "擴建", "扩建", "확장"],
  customers: ["お客さん", "Customers", "顧客", "顾客", "손님"],
  popularity: ["人気", "Popularity", "人氣", "人气", "인기도"],
  daily: ["デイリー", "Daily", "每日", "每日", "일일"],
  achievements: ["実績", "Achievements", "成就", "成就", "업적"],
  tasks: ["タスク", "Tasks", "任務", "任务", "과제"],
  guideStep: ["ガイド", "Guide step", "指南步驟", "指南步骤", "가이드 단계"],
  guest: ["ゲスト", "Guest", "訪客", "访客", "게스트"],
  weight: ["重み", "Weight", "權重", "权重", "가중치"],
  reward: ["報酬", "Reward", "獎勵", "奖励", "보상"],
  unavailable: ["利用できません", "Unavailable", "無法使用", "不可用", "사용할 수 없음"],
  retry: ["再試行", "Retry", "重試", "重试", "다시 시도"],
  currency: ["通貨", "Currency", "貨幣", "货币", "화폐"],
  task: ["タスク", "Task", "任務", "任务", "과제"],
  guide: ["ガイド", "Guide", "指南", "指南", "가이드"],
  previewUnavailable: ["プレビューできません", "Preview unavailable", "無法預覽", "无法预览", "미리 볼 수 없음"],
  outfitParts: ["衣装パーツ", "Outfit parts", "服裝部件", "服装部件", "의상 파츠"],
  scenes: ["シーン", "Scenes", "場景", "场景", "장면"],
  episodes: ["エピソード", "Episodes", "篇章", "篇章", "에피소드"],
  playback: ["再生", "Playback", "播放", "播放", "재생"],
};

export function uiText(locale: string, key: string): string {
  const values = UI_COPY[key];
  const index = Math.max(0, UI_LOCALES.indexOf(locale as (typeof UI_LOCALES)[number]));
  return values?.[index] || values?.[1] || key;
}

export function formatList(
  values: unknown[],
  locale: string,
  type: Intl.ListFormatOptions["type"] = "conjunction",
): string {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (items.length < 2) return items[0] || "";
  try {
    return new Intl.ListFormat(locale, { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}

export function readPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as JsonRecord)[key] : undefined), value);
}

export function recordValues(value: unknown): JsonRecord[] {
  return value && typeof value === "object"
    ? Object.values(value as JsonRecord).filter((item): item is JsonRecord => !!item && typeof item === "object")
    : [];
}

export function localizedText(value: unknown, locale: string): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (value as JsonRecord).values
      : undefined;
  if (!Array.isArray(list)) return "";
  const requested = UI_LOCALES.includes(locale as (typeof UI_LOCALES)[number])
    ? (locale as (typeof UI_LOCALES)[number])
    : "ja";
  const order = requested === "zh-CN" ? ["zh-CN", "zh-TW", "ja", "en", "ko"] : [requested, "ja", ...UI_LOCALES];
  for (const target of order) {
    const item = list[UI_LOCALES.indexOf(target as (typeof UI_LOCALES)[number])];
    if (typeof item === "string" && item.trim()) return item;
  }
  for (const item of list) if (typeof item === "string" && item.trim()) return item;
  return "";
}

export function currentReleaseServer(): string {
  return readReleaseServer();
}

export function catalogUrl(resource: string, id = "", server = currentReleaseServer()): string {
  const path = resource.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/v1/servers/${encodeURIComponent(server)}/${path}${id ? `/${encodeURIComponent(id)}` : ""}${!id && ["stories", "songs"].includes(resource) ? "?projection=4" : ""}`;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}
