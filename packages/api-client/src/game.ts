// L3 — GEB
// Input: 游戏区服、资源 ID 和查询参数。
// Output: 羽丘官方榜单、玩家资料与名片的类型化读取。
// Pos: [Map](../../L2.md)；公开游戏记录客户端。
// Effects/Dependencies: 经公共 ApiClient 传输，无内置密钥。
import { createApiClient, type ApiClientOptions } from "./index.js";
import type * as Game from "./game-types.js";
export type * from "./game-types.js";
export type GameRegion = "jp" | "tw" | "en" | "kr";
export interface GameReadOptions { signal?: AbortSignal }
export interface GameClientOptions extends Omit<ApiClientOptions, "baseUrl"> { baseUrl?: string; region: GameRegion }
const id = (value: string) => {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) throw new TypeError("ID must be a positive decimal string");
  return value;
};
export function createGameClient(options: GameClientOptions) {
  if (!["jp", "tw", "en", "kr"].includes(options.region)) throw new TypeError("Invalid game region");
  const api = createApiClient({ ...options, baseUrl: options.baseUrl ?? "https://haneoka.org/api/v1/" });
  const read = <T>(path: string, scope: GameReadOptions = {}) =>
    api.get<T>(`game/records/${options.region}/${path}`, { ...(scope.signal ? { signal: scope.signal } : {}) });
  return {
    profile: (profileId: string, scope?: GameReadOptions) => read<Game.PlayerProfile>(`players/${id(profileId)}`, scope),
    songRanking: (songId: string, scope?: GameReadOptions) => read<Game.Ranking>(`songs/${id(songId)}/ranking`, scope),
    currentEvent: (scope?: GameReadOptions) => read<Game.CurrentEvent>("events/current", scope),
    eventRanking: (eventId: string, scope?: GameReadOptions) => read<Game.Ranking>(`events/${id(eventId)}/total/latest`, scope),
    challengeRanking: (eventId: string, challengeId: string, scope?: GameReadOptions) =>
      read<Game.Ranking>(`events/${id(eventId)}/challenges/${id(challengeId)}/latest`, scope),
    arenaRanking: (seasonId: string, bandId: string, start = 1, scope?: GameReadOptions) =>
      read<Game.Ranking>(`arena/seasons/${id(seasonId)}/leagues/${id(bandId)}/ranking?start=${start}`, scope),
  };
}
