// L3 — GEB
// Input: The device-authorized local session, story and its archived dependencies.
// Output: The website's story detail, transcript and Vega player on the App's offline origin.
// Pos: [Map](../L2.md); downloaded story detail entry point.
// Effects/Dependencies: Reads installed files and reports rendered detail, player readiness and progress to the host.
import "../styles/index.css";
import "../styles/story.css";
import "./player.css";
import { initializeI18nClient } from "../i18n/client";
import { normalizeLocale } from "@haneoka/i18n";
import { DefaultStoryResourceResolver } from "@haneoka/vega/renderer-kit";
import { fetchJson, recordValues, type JsonRecord } from "../lit/shared/catalog";
import type { VegaProject } from "@haneoka/vega-protocol";

interface Session {
  server: string;
  portableStory?: boolean;
  releaseId: string;
  episode: string;
  title: string;
  chapterTitle?: string;
  token: string;
  progress: number;
  theme: "light" | "dark" | null;
  locale: string;
  returnUrl: string;
}

interface PortableStory {
  story: JsonRecord;
  live2d: JsonRecord[];
  characters?: JsonRecord[];
  project?: VegaProject;
  provider: boolean;
}

async function openDetail(): Promise<void> {
  const session = await fetchJson<Session>("/offline/session.json");
  const locale = normalizeLocale(session.locale);
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
  const preferred = matchMedia("(prefers-color-scheme: dark)");
  const applyTheme = () => {
    document.documentElement.dataset.theme = session.theme ?? (preferred.matches ? "dark" : "light");
  };
  applyTheme();
  if (!session.theme) preferred.addEventListener("change", applyTheme);
  const i18n = initializeI18nClient({
    namespaces: ["common", "story"],
    load: (language) => fetchJson(`/i18n/${encodeURIComponent(language)}.json`),
  });
  const catalog = await i18n.ready();
  const back = document.querySelector<HTMLAnchorElement>("[data-entity-back]")!;
  back.href = session.returnUrl;
  back.setAttribute("aria-label", catalog.text("common.actions.back"));
  document.querySelector("h1")!.textContent = document.title = session.title;
  const { StoryWorkspace } = await import("../lit/story-workspace");
  const workspace = new StoryWorkspace();
  workspace.locale = locale;
  const portable = session.portableStory ? await fetchJson<PortableStory>("/offline/document.json") : undefined;
  const base = `/api/v1/servers/${encodeURIComponent(session.server)}/`;
  let story: JsonRecord;
  if (portable) {
    workspace.characters = portable.characters ?? [];
    if (portable.provider) workspace.origin = session.server.startsWith("gbp.") ? "bestdori" : "sekai";
    story = portable.project
      ? {
          ...(await import("@haneoka/vega/web")).vegaProjectToAdvStory(portable.project),
          ...portable.story,
        }
      : portable.story;
  } else {
    const [episode, index, characters, bands] = await Promise.all([
      fetchJson<JsonRecord>(`${base}stories/${encodeURIComponent(session.episode)}`),
      fetchJson<JsonRecord>(`${base}stories`),
      fetchJson<JsonRecord>(`${base}characters`),
      fetchJson<JsonRecord>(`${base}bands`),
    ]);
    workspace.chapters = recordValues(index.chapters);
    workspace.characters = recordValues(characters);
    workspace.bands = recordValues(bands);
    story = episode;
  }
  const send = (action: "detail-ready" | "ready" | "progress", body?: string) =>
    fetch(`/offline/${action}`, { method: "POST", body, headers: { "X-Haneoka-Session": session.token } });
  workspace.reader = {
    story: { storyId: session.episode, title: session.title, ...story },
    server: portable ? "intl" : session.server,
    project: portable?.project,
    backHref: session.returnUrl,
    offline: {
      provider: portable?.provider ?? false,
      live2d: portable?.provider ? portable.live2d : undefined,
      releaseId: session.releaseId,
      chapterTitle: session.chapterTitle,
      resources: new DefaultStoryResourceResolver([
        {
          schemes: ["haneoka-story"],
          async load(url, signal) {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error(`Offline asset unavailable: ${url.pathname}`);
            return new Uint8Array(await response.arrayBuffer());
          },
        },
      ]),
      progress: {
        ordinal: session.progress,
        save(ordinal) {
          this.ordinal = ordinal;
          void send("progress", String(ordinal)).catch(console.error);
        },
      },
      playerReady() {
        void send("ready").catch(console.error);
      },
    },
  };
  document.querySelector("main")!.append(workspace);
  await workspace.updateComplete;
  if (workspace.querySelector('.story-detail[data-view="text"]')) await send("detail-ready");
}

void openDetail().catch((error) => {
  console.error(error);
  const banner = document.querySelector<HTMLElement>("#error")!;
  banner.textContent = initializeI18nClient().current().text("common.states.error");
  banner.hidden = false;
});
