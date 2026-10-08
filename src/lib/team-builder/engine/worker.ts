/// <reference lib="webworker" />
/** Team engine Worker: compiles the release once, then serves searches and evaluations. */
import { pinnedSongAssetUrl } from "../solver/song-loader";
import { teamBuilderSourceIdentity } from "../data/source";
import { compileFromTeamData, type EngineMaster } from "./master";
import { convertChartBytes } from "./chart";
import { ChartCache, evaluateTeam, explainTeam, runEngine } from "./api";
import type { EngineCall, EngineReply } from "./protocol";

let master: EngineMaster | null = null;
let charts: ChartCache | null = null;
const post = (reply: EngineReply) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(reply);

self.onmessage = async (event: MessageEvent<EngineCall>) => {
  const call = event.data;
  try {
    if (call.type === "init") {
      master = compileFromTeamData(call.data);
      charts = new ChartCache(master, async (engine, ref) => {
        const pinned = teamBuilderSourceIdentity(call.data, "songs", ref.songId);
        const difficulty = engine.songs.get(ref.songId)?.difficulties.find((row) => row.difficulty === ref.difficulty);
        if (!difficulty?.file) throw new Error("chart-file-missing");
        const response = await fetch(pinnedSongAssetUrl(pinned, difficulty.file), { credentials: "omit" });
        if (!response.ok) throw new Error(`chart-http:${response.status}`);
        // The URL pins the release; a server that labels it must agree.
        const release = response.headers.get("x-haneoka-release-id");
        if (release && release !== pinned.releaseId) throw new Error("chart-release-identity-mismatch");
        return convertChartBytes(new Uint8Array(await response.arrayBuffer()));
      });
      post({ type: "ready", id: call.id });
      return;
    }
    if (!master || !charts) throw new Error("engine-not-ready");
    if (call.type === "run") {
      let last = 0;
      const result = await runEngine(master, charts, call.request, (done, total) => {
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          post({ type: "progress", id: call.id, done, total });
        }
      });
      post({ type: "result", id: call.id, result });
    } else if (call.type === "evaluate") post({ type: "result", id: call.id, result: await evaluateTeam(master, charts, call.request) });
    else if (call.type === "explain") post({ type: "result", id: call.id, result: await explainTeam(master, charts, call.request) });
    else if (call.type === "charts") {
      await Promise.all(call.songs.map((song) => charts!.chart(song)));
      post({ type: "result", id: call.id, result: null });
    }
  } catch (error) {
    post({ type: "error", id: call.id, message: error instanceof Error ? error.message : String(error) });
  }
};
