// L3 — GEB
// Input: 编辑器、社区 API 和 Sonolus 的谱面与素材身份。
// Output: 云端草稿、不可变版本、谱面统计／推荐值、只读播放投影、播放器路径及独立音频／封面引用契约。
// Pos: [Map](../L2-2.md)；谱面创作与社区共享的数据边界。
// Effects/Dependencies: 类型、纯路径与默认值；素材 URL 由 Worker 从引用解析并保留内容快照；服务器引用可绑定所选内容 SHA。
import type { Project } from "../../../packages/chart-editor/src/model";
import type { ChartDifficultyEstimate } from "../chart-difficulty";

export interface CommunityChartAnalysis {
  version: string;
  n: number;
  time: number;
  nps: number;
  firstBpm: number;
  minBpm: number;
  maxBpm: number;
  difficultyEstimate: ChartDifficultyEstimate | null;
}

export type ChartMediaRef =
  | { kind: "upload"; id: string }
  | {
      kind: "server";
      provider: "our-notes" | "bestdori";
      server: string;
      songId: string;
      releaseId?: string;
      sha256?: string;
    };
export interface ChartPublication {
  audio: ChartMediaRef | null;
  cover: ChartMediaRef | null;
  summary: string;
  visibility: "public" | "unlisted";
  remix: boolean;
  upstreamId?: string;
}
export interface CommunityChartRevision extends ChartPublication {
  project: Project;
  revision: number;
  createdAt: number;
  publishedAt: number | null;
  audioUrl: string;
  coverUrl: string;
}
export interface CommunityChartItem {
  id: string;
  title: string;
  artist: string;
  charter: string;
  difficulty: string;
  level: string;
  summary: string;
  ownerId: string;
  ownerName: string;
  ownerUid: number;
  version: number;
  revision: number;
  publishedRevision: number | null;
  publishedAt: number | null;
  updatedAt: number;
  coverUrl: string;
  audioUrl: string;
  remix: boolean;
  visibility: "public" | "unlisted";
  canEdit: boolean;
  likeCount: number;
  liked: boolean;
  upstreamId: string | null;
  analysis: CommunityChartAnalysis | null;
}
export interface CommunityChartPlayback {
  ss: string;
  chart?: import("@haneoka/cassiopeia").ChartDocument;
  visualProfiles?: import("@haneoka/cassiopeia-plugin-our-notes").NativeChartVisualProfiles;
  offsetMs: number;
  timeScaleChanges: { timeMs: number; scale: number }[];
}
export const emptyChartPublication = (): ChartPublication => ({
  audio: null,
  cover: null,
  summary: "",
  visibility: "public",
  remix: true,
});
export const chartLevelName = (id: string) => `haneoka-community-${id}`;
export { communityChartPath, communityChartPlayerPath } from "../community-chart-route";
