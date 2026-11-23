// L3 — GEB
// Input: Story session and assets served by the App's local playback origin.
// Output: The website's Vega stage in a standalone, downloadable player.
// Pos: [Map](../L2.md); offline player entry point.
// Effects/Dependencies: Loads only the installed player and session resources, then reports boot to the host.
import "../styles/index.css";
import "../styles/story.css";
import "./player.css";
import { initializeI18nClient } from "../i18n/client";
import { normalizeLocale } from "@haneoka/i18n";
import { DefaultStoryResourceResolver } from "@haneoka/vega/renderer-kit";
import { fetchJson } from "../lit/shared/catalog";
import type { VegaProject } from "@haneoka/vega-protocol";
import "../lit/runtime/vega-story-stage";
import type { VegaStoryStage } from "../lit/runtime/vega-story-stage";

interface Session {
  server: string;
  portableStory?: boolean;
  releaseId: string;
  episode: string;
  title: string;
  token: string;
  progress: number;
  theme: "light" | "dark" | null;
  locale: string;
  returnUrl: string;
}

interface PortableStory {
  story: Record<string, unknown>;
  live2d: Record<string, unknown>[];
  project?: VegaProject;
  provider: boolean;
}

async function play(): Promise<void> {
  const session = await fetchJson<Session>("/offline/session.json");
  const locale = normalizeLocale(session.locale);
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
  const preferred = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => { document.documentElement.dataset.theme = session.theme ?? (preferred.matches ? "dark" : "light"); };
  applyTheme();
  if (!session.theme) preferred.addEventListener("change", applyTheme);
  const i18n = initializeI18nClient({
    namespaces: ["common", "story"],
    load: async (language) => fetchJson(`/i18n/${encodeURIComponent(language)}.json`),
  });
  const catalog = await i18n.ready();
  const back = document.querySelector<HTMLAnchorElement>("#back")!;
  back.href = session.returnUrl;
  back.querySelector("span")!.textContent = catalog.text("common.actions.back");
  document.querySelector("h1")!.textContent = session.title;
  const portable = session.portableStory ? await fetchJson<PortableStory>("/offline/document.json") : undefined;
  const story = portable?.story ?? await fetchJson<Record<string, unknown>>(
    `/api/v1/servers/${session.server}/stories/${encodeURIComponent(session.episode)}`,
  );
  const stage = document.createElement("vega-story-stage") as VegaStoryStage;
  stage.story = story;
  stage.server = portable ? "intl" : session.server;
  stage.locale = locale;
  if (portable) {
    stage.communityProject = portable.project ?? undefined;
    if (portable.provider) {
      stage.providerBase = "/offline";
      stage.offlineLive2d = portable.live2d;
    }
  } else {
    stage.releaseId = session.releaseId;
  }
  stage.offlineResources = new DefaultStoryResourceResolver([{
    schemes: ["haneoka-story"],
    async load(url, signal) {
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Offline asset unavailable: ${url.pathname}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  }]);
  const send = (action: "ready" | "progress", body?: string) =>
    fetch(`/offline/${action}`, { method: "POST", body, headers: { "X-Haneoka-Session": session.token } });
  stage.addEventListener("vega-offline-ready", () => { void send("ready").catch(console.error); }, { once: true });
  stage.offlineProgress = {
    ordinal: session.progress,
    save: (ordinal) => { void send("progress", String(ordinal)).catch(console.error); },
  };
  document.querySelector("main")!.append(stage);
}

void play().catch((error) => {
  console.error(error);
  const banner = document.querySelector<HTMLElement>("#error")!;
  banner.textContent = initializeI18nClient().current().text("common.states.error");
  banner.hidden = false;
});
