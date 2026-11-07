// L3 — GEB
// Input: AFDIAN_USER_ID／AFDIAN_TOKEN、PATREON_CREATOR_TOKEN（可选 PATREON_CAMPAIGN_ID），以及站点的档位与 Ko-fi 名单接口。
// Output: `/data/sponsors/v1.json` 来源快照：爱发电与 Patreon 赞助者带稳定来源键（爱发电用户 id／Patreon 会员 id 的摘要）、首次／最近支持时间和按站点档位门槛计算的档位；平台不给名字（隐藏身份）的来源键列入 `masked`；Ko-fi 名单保持原兼容字段。
// Pos: [Map](L2-2.md)；构建期赞助者来源读取器；Worker 把快照并入 D1 来源层，管理员改动只在 Worker 名单生效。
// Effects/Dependencies: 构建输入捕获与两个平台的创作者 API；凭据缺失的平台不读取，已配置的平台读取失败则构建失败。
import { createHash } from "node:crypto";
import {
  DEFAULT_SPONSOR_TIERS,
  SPONSOR_NAME_LENGTH,
  sponsorTier,
  type SponsorChannel,
  type SponsorTier,
} from "../config/sponsor";
import { staticBuildJson } from "./static-input-store";

export interface SourceSponsor {
  name: string;
  avatar: string | null;
  platform: SponsorChannel;
  /** `afdian:` and a digest of the Afdian user id, or `patreon:` and a digest of the Patreon member id; absent on Ko-fi rows. */
  key?: string;
  /** First support, in seconds. */
  since?: number;
  /** Latest payment, in seconds, where the platform reports one. */
  last?: number | null;
}
export interface ActiveSourceSponsor extends SourceSponsor {
  tier: string;
}
export interface SponsorList {
  updatedAt: string;
  /** Platforms read in full for this snapshot; their supporters missing from it have ended support. */
  sources: SponsorChannel[];
  active: ActiveSourceSponsor[];
  past: SourceSponsor[];
  /** Source keys of supporters the platform lists without a name: they hid their identity, so earlier names and avatars stop showing. */
  masked: string[];
}

interface Row extends ActiveSourceSponsor {
  active: boolean;
  since: number;
}
type Tiers = readonly Pick<SponsorTier, "id" | "cny" | "usd">[];

const MONTH = 32 * 24 * 3600;
const AVATAR_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(afdiancdn\.com|patreonusercontent\.com|patreon\.com)\//u;
const avatar = (url: unknown) => (typeof url === "string" && AVATAR_HOSTS.test(url) ? url : null);
const name = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, SPONSOR_NAME_LENGTH) : "");
const sourceKey = (platform: "afdian" | "patreon", id: string) =>
  `${platform}:${createHash("sha256").update(`haneoka-sponsor/1:${platform}:${id}`).digest("hex").slice(0, 32)}`;

async function retry<T>(load: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function afdian(userId: string, token: string, tiers: Tiers): Promise<Row[]> {
  const rows: Row[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (let page = 1, pages = 1; page <= pages; page++) {
    const params = JSON.stringify({ page, per_page: 100 });
    const ts = Math.floor(Date.now() / 1000);
    const sign = createHash("md5").update(`${token}params${params}ts${ts}user_id${userId}`).digest("hex");
    const body = await retry(async () => {
      const response = await fetch("https://afdian.com/api/open/query-sponsor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, params, ts, sign }),
        signal: AbortSignal.timeout(15000),
      });
      const json = (await response.json()) as {
        ec: number;
        em: string;
        data?: { total_page: number; list: unknown[] };
      };
      if (!response.ok || json.ec !== 200 || !json.data) throw new Error(`Afdian sponsors: ${json.ec} ${json.em}`);
      return json.data;
    });
    pages = body.total_page;
    for (const item of body.list as {
      current_plan?: { price?: string };
      first_pay_time?: number;
      last_pay_time?: number;
      user?: { user_id?: string; name?: string; avatar?: string };
    }[]) {
      if (!item.user?.user_id) continue;
      rows.push({
        key: sourceKey("afdian", item.user.user_id),
        name: name(item.user.name),
        avatar: avatar(item.user.avatar),
        platform: "afdian",
        active: now - (item.last_pay_time ?? 0) <= MONTH,
        tier: sponsorTier(tiers, Number(item.current_plan?.price) || 0, "CNY"),
        since: item.first_pay_time ?? now,
        last: item.last_pay_time ?? null,
      });
    }
  }
  return rows;
}

async function patreon(token: string, campaign: string, tiers: Tiers): Promise<Row[]> {
  const rows: Row[] = [];
  let url: string | undefined =
    `https://www.patreon.com/api/oauth2/v2/campaigns/${campaign}/members?include=user` +
    "&fields%5Bmember%5D=full_name,patron_status,currently_entitled_amount_cents,lifetime_support_cents,pledge_relationship_start,last_charge_date" +
    "&fields%5Buser%5D=image_url,thumb_url&page%5Bcount%5D=500";
  while (url) {
    const page: {
      data: {
        id: string;
        attributes: {
          full_name?: string;
          patron_status?: string | null;
          currently_entitled_amount_cents?: number;
          lifetime_support_cents?: number;
          pledge_relationship_start?: string | null;
          last_charge_date?: string | null;
        };
        relationships?: { user?: { data?: { id: string } } };
      }[];
      included?: { id: string; type: string; attributes: { image_url?: string | null; thumb_url?: string | null } }[];
      links?: { next?: string };
    } = await retry(async () => {
      const response = await fetch(url!, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Patreon members: ${response.status}`);
      return response.json();
    });
    const users = new Map(
      (page.included ?? []).filter((row) => row.type === "user").map((row) => [row.id, row.attributes]),
    );
    for (const member of page.data) {
      const a = member.attributes;
      const lifetime = (a.lifetime_support_cents ?? 0) / 100;
      if (a.patron_status !== "active_patron" && lifetime <= 0) continue;
      const image = users.get(member.relationships?.user?.data?.id ?? "");
      rows.push({
        // The member id stays the same across pledges and is present when the user relationship is hidden.
        key: sourceKey("patreon", `member:${member.id}`),
        name: name(a.full_name),
        avatar: avatar(image?.image_url) ?? avatar(image?.thumb_url),
        platform: "patreon",
        active: a.patron_status === "active_patron",
        tier: sponsorTier(tiers, (a.currently_entitled_amount_cents ?? 0) / 100, "USD"),
        since: a.pledge_relationship_start ? Date.parse(a.pledge_relationship_start) / 1000 : Date.now() / 1000,
        last: a.last_charge_date ? Math.floor(Date.parse(a.last_charge_date) / 1000) : null,
      });
    }
    url = page.links?.next;
  }
  return rows;
}

/** The site's current tier thresholds; the worker serving them deploys after the static build. */
async function siteTiers(origin: string): Promise<Tiers> {
  return retry(async () => {
    const response = await fetch(`${origin}/api/v1/sponsors`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return DEFAULT_SPONSOR_TIERS;
    if (!response.ok) throw new Error(`Sponsor tiers: ${response.status}`);
    const { tiers } = (await response.json()) as { tiers?: Tiers };
    return tiers?.length ? tiers : DEFAULT_SPONSOR_TIERS;
  });
}

/** Ko-fi payments arrive by webhook and stay in the worker; this list keeps the snapshot's earlier contents. */
async function kofi(origin: string): Promise<Row[]> {
  const body = await retry(async () => {
    const response = await fetch(`${origin}/api/v1/sponsors/kofi`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return { active: [], past: [] };
    if (!response.ok) throw new Error(`Ko-fi sponsors: ${response.status}`);
    return (await response.json()) as {
      active: { name: string; tier: string; since: number }[];
      past: { name: string; since: number }[];
    };
  });
  return [
    ...body.active.map((row) => ({
      name: name(row.name),
      avatar: null,
      platform: "kofi" as const,
      active: true,
      tier: row.tier,
      since: row.since,
    })),
    ...body.past.map((row) => ({
      name: name(row.name),
      avatar: null,
      platform: "kofi" as const,
      active: false,
      tier: "",
      since: row.since,
    })),
  ];
}

async function load(): Promise<SponsorList> {
  const env = process.env;
  const origin = env.STATIC_OPERATION_ORIGIN || env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
  const tiers = await siteTiers(origin);
  const sources: SponsorChannel[] = [];
  if (env.AFDIAN_USER_ID && env.AFDIAN_TOKEN) sources.push("afdian");
  if (env.PATREON_CREATOR_TOKEN) sources.push("patreon");
  const rows = (
    await Promise.all([
      sources.includes("afdian") ? afdian(env.AFDIAN_USER_ID!, env.AFDIAN_TOKEN!, tiers) : [],
      sources.includes("patreon") ? patreon(env.PATREON_CREATOR_TOKEN!, env.PATREON_CAMPAIGN_ID || "16408311", tiers) : [],
      kofi(origin),
    ])
  ).flat();
  const named = rows.filter((row) => row.name);
  const order = (a: Row, b: Row) => a.since - b.since;
  const person = ({ name, avatar, platform, key, since, last }: Row): SourceSponsor =>
    key ? { name, avatar, platform, key, since: Math.floor(since), last } : { name, avatar, platform };
  return {
    updatedAt: new Date().toISOString(),
    sources,
    active: named
      .filter((row) => row.active)
      .sort(order)
      .map((row) => ({ ...person(row), tier: row.tier })),
    past: named
      .filter((row) => !row.active)
      .sort(order)
      .map(person),
    masked: rows.flatMap((row) => (row.key && !row.name ? [row.key] : [])),
  };
}

let list: Promise<SponsorList> | undefined;
/** Resolve once per build; shards read the list captured during preparation. */
export function sponsorList(): Promise<SponsorList> {
  return (list ??= staticBuildJson("sponsors:v3", "public-data", load));
}
