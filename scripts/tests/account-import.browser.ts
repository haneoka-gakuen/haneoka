import { LitElement } from "lit";
import { TeamBuilder } from "../../src/lit/team-builder";
import { Catalog } from "../../src/lit/team-builder/catalog";
import { compileFromTeamData } from "../../src/lib/team-builder/engine/master";
import { readBox } from "../../src/lib/team-builder/sync/box-view";
import { initializeI18nClient } from "../../src/i18n/client";
import { data } from "./account-import-fixture";
import "../../src/styles/index.css";
import "../../src/styles/team-builder.css";
import zh from "../../public/i18n/zh-CN.json";
initializeI18nClient({ seed: { locale: "zh-CN", version: "test", namespaces: { common: zh } } });
class SyntheticTeamBuilder extends TeamBuilder {
  connectedCallback() {
    LitElement.prototype.connectedCallback.call(this);
  }
}
customElements.define("synthetic-team-builder", SyntheticTeamBuilder);
const host = new SyntheticTeamBuilder();
host.locale = "zh-CN";
host.data = structuredClone(data);
for (const [id, row] of Object.entries(host.data.characters)) row.characterName = `合成角色 ${id}`;
host.master = compileFromTeamData(host.data);
host.catalog = new Catalog(host, host.data, host.master);
host.snapshot = { owner: null, entries: {}, status: "local", pending: 0, lastSyncedAt: null, error: null, version: 1 };
host.view = readBox({});
host.settings = { ...host.settings, goal: "power", buildGoal: "power", powerSong: false, noSnaps: true };
host.tab = "box";
let writes = 0;
host.store = {
  set(changes: { key: string; value: unknown }[]) {
    writes++;
    const entries = { ...host.snapshot!.entries };
    for (const change of changes) entries[change.key] = { v: change.value, t: 1, c: "synthetic", r: 1 } as never;
    (host as unknown as { adopt(value: unknown): void }).adopt({
      ...host.snapshot,
      entries,
      version: host.snapshot!.version + 1,
    });
  },
  dispose() {},
} as never;
document.body.append(host);
Object.assign(window, { host, fixture: data, writeCount: () => writes });
