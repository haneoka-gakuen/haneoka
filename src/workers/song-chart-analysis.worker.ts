// Private song-detail worker; owner: [SongSkillPoints](../lit/song-skill-points.ts).
import { compileFromMasterTables, type EngineMaster } from "../lib/team-builder/engine/master";
import { chartGekisoRates } from "../lib/team-builder/engine/gekiso";
import type { ChartSource } from "../lib/team-builder/engine/chart";
import type { CrossCatalogIdentity } from "../lib/cross-server/catalog";
import type { GekisouRates } from "../lib/chart-rates";

export interface SongRateRequest {
  id: number;
  level: number;
  missions: number[];
  chart?: ChartSource;
  rules?: { identity: CrossCatalogIdentity; tables: Record<string, Record<string, unknown>[]> };
}
export interface SongRateResponse { id: number; result?: GekisouRates; error?: true }
let master: EngineMaster | undefined;
let chart: ChartSource | undefined;
self.onmessage = ({ data }: MessageEvent<SongRateRequest>) => {
  try {
    if (data.rules) {
      const { identity, tables } = data.rules;
      master = compileFromMasterTables(identity, table => tables[table] ?? null);
    }
    if (data.chart) chart = data.chart;
    if (!master || !chart) throw new Error("Missing chart rules");
    const result = chartGekisoRates(master, chart, data.level, data.missions);
    self.postMessage(result ? { id: data.id, result } : { id: data.id, error: true });
  } catch {
    self.postMessage({ id: data.id, error: true });
  }
};
