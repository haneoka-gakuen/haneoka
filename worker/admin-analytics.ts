type Binding = string | number | null;
export interface AdminVisitFilter {
  sql: string;
  values: Binding[];
  from: number | null;
  to: number | null;
}
const country = `CASE WHEN v.ip_country_code GLOB '[A-Z][A-Z]' AND v.ip_country_code NOT IN ('XX','T1') THEN v.ip_country_code ELSE NULL END`;
const coordinate = (key: "latitude" | "longitude") => {
  const bound = key === "latitude" ? 90 : 180;
  return `CASE WHEN json_type(v.ip_details_json,'$.${key}') IN ('integer','real') AND json_extract(v.ip_details_json,'$.${key}') BETWEEN -${bound} AND ${bound} THEN round(json_extract(v.ip_details_json,'$.${key}'),1) ELSE NULL END`;
};
const city = `CASE WHEN json_type(v.ip_details_json,'$.city')='text' THEN NULLIF(trim(json_extract(v.ip_details_json,'$.city')),'') ELSE NULL END`;
const region = `NULLIF(v.ip_region_code,'')`;
const numeric = (text: string | null): number | null => {
  if (text === null) return null;
  if (!/^[0-9]{1,13}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new TypeError("Invalid visited time");
  return Number(text);
};
export function adminVisitFilter(url: URL): AdminVisitFilter {
  const sql: string[] = [],
    values: Binding[] = [];
  const get = (key: string) => {
    if (url.searchParams.getAll(key).length > 1) throw new TypeError("Duplicate geo parameter");
    return url.searchParams.get(key);
  };
  const from = numeric(get("visitedFrom")),
    to = numeric(get("visitedTo"));
  if (from !== null && to !== null && to <= from) throw new TypeError("Invalid visited interval");
  if (from !== null) {
    sql.push("v.visited_at>=?");
    values.push(from);
  }
  if (to !== null) {
    sql.push("v.visited_at<?");
    values.push(to);
  }
  for (const [key, expression, limit] of [
    ["geoCountry", country, 2],
    ["geoRegion", region, 32],
    ["geoCity", city, 160],
  ] as const) {
    const value = get(key);
    const unknown = get(`${key}Unknown`);
    if (unknown !== null) {
      if (unknown !== "1" || value !== null) throw new TypeError("Invalid unknown geo filter");
      sql.push(`${expression} IS NULL`);
      continue;
    }
    if (value === null) continue;
    if (key === "geoCountry" && value === "unknown") sql.push(`${expression} IS NULL`);
    else {
      if (
        !value.length ||
        value.length > limit ||
        /[\p{Cc}\p{Cs}]/u.test(value) ||
        (key === "geoCountry" && !/^[A-Z]{2}$/.test(value))
      )
        throw new TypeError("Invalid geo filter");
      sql.push(`${expression}=?`);
      values.push(value);
    }
  }
  const lat = get("geoLat"),
    lng = get("geoLng");
  if ((lat === null) !== (lng === null)) throw new TypeError("Coordinate pair required");
  if (lat !== null && lng !== null) {
    if (
      !/^-?\d{1,3}(?:\.\d)?$/.test(lat) ||
      !/^-?\d{1,3}(?:\.\d)?$/.test(lng) ||
      Math.abs(Number(lat)) > 90 ||
      Math.abs(Number(lng)) > 180
    )
      throw new TypeError("Invalid coordinate filter");
    sql.push(`${coordinate("latitude")}=?`, `${coordinate("longitude")}=?`);
    values.push(Number(lat), Number(lng));
  }
  if (get("geoCoordinates") === "unknown")
    sql.push(`(${coordinate("latitude")} IS NULL OR ${coordinate("longitude")} IS NULL)`);
  else if (url.searchParams.has("geoCoordinates")) throw new TypeError("Invalid coordinate mode");
  return { sql: sql.length ? sql.join(" AND ") : "1", values, from, to };
}
const reply = (request: Request, value: unknown, status = 200) =>
  new Response(request.method === "HEAD" ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    },
  });
export async function readAdminGeo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let filter: AdminVisitFilter;
  try {
    filter = adminVisitFilter(url);
  } catch {
    return reply(request, { error: { code: "invalid_geo_filter", message: "Invalid latest-visit filter" } }, 400);
  }
  if (["status", "role"].some((key) => url.searchParams.getAll(key).length > 1))
    return reply(request, { error: { code: "invalid_cohort", message: "Duplicate cohort parameter" } }, 400);
  const status = url.searchParams.get("status"),
    role = url.searchParams.get("role");
  if (
    (status && !["active", "suspended", "deleted"].includes(status)) ||
    (role && !["admin", "moderator", "member"].includes(role))
  )
    return reply(request, { error: { code: "invalid_cohort", message: "Invalid current user cohort" } }, 400);
  const terms = [filter.sql],
    values = [...filter.values];
  if (status) {
    terms.push("p.status=?");
    values.push(status);
  }
  if (role) {
    terms.push("p.role=?");
    values.push(role);
  }
  const source = `FROM "user" AS u LEFT JOIN community_profile AS p ON p.user_id=u.id LEFT JOIN community_user_last_visit AS v ON v.user_id=u.id WHERE ${terms.join(" AND ")}`;
  const results = await env.DB.batch<{
    countryCode: string | null;
    regionCode: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    count: number;
    total: number;
    unknownCountry: number;
    unknownCoordinates: number;
    noVisit: number;
  }>([
    env.DB.prepare(
      `SELECT COUNT(DISTINCT u.id) AS total,COUNT(DISTINCT CASE WHEN ${country} IS NULL THEN u.id END) AS unknownCountry,
      COUNT(DISTINCT CASE WHEN ${coordinate("latitude")} IS NULL OR ${coordinate("longitude")} IS NULL THEN u.id END) AS unknownCoordinates,
      COUNT(DISTINCT CASE WHEN v.visited_at IS NULL THEN u.id END) AS noVisit ${source}`,
    ).bind(...values),
    env.DB.prepare(
      `SELECT ${country} AS countryCode,COUNT(DISTINCT u.id) AS count ${source} GROUP BY countryCode ORDER BY count DESC,countryCode`,
    ).bind(...values),
    env.DB.prepare(
      `SELECT ${country} AS countryCode,${region} AS regionCode,${city} AS city,${coordinate("latitude")} AS latitude,${coordinate("longitude")} AS longitude,COUNT(DISTINCT u.id) AS count
      ${source} AND ${coordinate("latitude")} IS NOT NULL AND ${coordinate("longitude")} IS NOT NULL GROUP BY countryCode,regionCode,city,latitude,longitude ORDER BY count DESC,countryCode,regionCode,city,latitude,longitude LIMIT 5001`,
    ).bind(...values),
  ]);
  if (results.length !== 3 || !results[0]?.results[0]) throw new Error("Incomplete geographic aggregate");
  const usersUrl = (row: Record<string, unknown>, coords = false) => {
    const query = new URLSearchParams();
    for (const key of [
      "status",
      "role",
      "visitedFrom",
      "visitedTo",
      "geoCountry",
      "geoRegion",
      "geoCity",
      "geoLat",
      "geoLng",
      "geoCoordinates",
      "geoCountryUnknown",
      "geoRegionUnknown",
      "geoCityUnknown",
    ]) {
      const v = url.searchParams.get(key);
      if (v !== null) query.set(key, v);
    }
    const setGeo = (key: string, value: unknown) => {
      query.delete(key);
      query.delete(`${key}Unknown`);
      if (value == null) query.set(`${key}Unknown`, "1");
      else query.set(key, String(value));
    };
    setGeo("geoCountry", row.countryCode);
    if (coords) {
      setGeo("geoRegion", row.regionCode);
      setGeo("geoCity", row.city);
      query.set("geoLat", String(row.latitude));
      query.set("geoLng", String(row.longitude));
    }
    return `/api/v1/admin/users?${query}`;
  };
  return reply(request, {
    generatedAt: Date.now(),
    basis: "latest-authenticated-visit-per-Haneoka-user",
    coordinatePrecision: 1,
    window: { from: filter.from, to: filter.to, meaning: "latest visited_at; not historical journeys" },
    cohort: { status: status ?? "all", role: role ?? "all" },
    totals: results[0].results[0],
    countries: results[1]!.results.map((row) => ({
      countryCode: row.countryCode,
      count: row.count,
      usersUrl: usersUrl(row),
    })),
    points: results[2]!.results.slice(0, 5000).map((row) => ({ ...row, usersUrl: usersUrl(row, true) })),
    pointsTruncated: results[2]!.results.length > 5000,
  });
}
export async function readAdminSeries(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    bucket = url.searchParams.get("bucket") ?? "day";
  const now = Date.now(),
    today = new Date(now).toISOString().slice(0, 10),
    defaultTo = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10),
    defaultFrom = new Date(Date.parse(defaultTo) - 30 * 86400000).toISOString().slice(0, 10);
  const from = url.searchParams.get("from") ?? defaultFrom,
    to = url.searchParams.get("to") ?? defaultTo;
  const parse = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(Date.parse(s)).toISOString().slice(0, 10) === s
      ? Date.parse(s)
      : NaN;
  const start = parse(from),
    end = parse(to),
    days = (end - start) / 86400000;
  if (
    !["day", "month"].includes(bucket) ||
    !Number.isFinite(days) ||
    days <= 0 ||
    days > (bucket === "day" ? 366 : 3660) ||
    ["from", "to", "bucket"].some((k) => url.searchParams.getAll(k).length > 1)
  )
    return reply(
      request,
      {
        error: { code: "invalid_series_window", message: "Use UTC YYYY-MM-DD [from,to), day<=366 or month<=3660 days" },
      },
      400,
    );
  const definitions = [
    ["registrations", '"user"', "createdAt", true, "1"],
    ["posts", "community_post", "created_at", false, "1"],
    ["comments", "community_comment", "created_at", false, "1"],
    ["attachments", "community_attachment", "created_at", false, "1"],
    ["moderationJobsCreated", "community_moderation_job", "created_at", false, "1"],
    [
      "moderationDecisions",
      "community_moderation_event",
      "created_at",
      false,
      "to_status IN ('allow','block','review','superseded')",
    ],
    ["moderationCasesLatestCompleted", "community_moderation_case", "completed_at", false, "completed_at IS NOT NULL"],
  ] as const;
  const format = bucket === "day" ? "%Y-%m-%d" : "%Y-%m";
  const results = await env.DB.batch<{ bucket: string; count: number }>(
    definitions.map(([, table, column, text, condition]) =>
      env.DB.prepare(
        text
          ? `SELECT strftime('${format}',${column}) AS bucket,COUNT(*) AS count FROM ${table} WHERE ${column}>=? AND ${column}<? AND ${condition} AND strftime('${format}',${column}) IS NOT NULL GROUP BY bucket ORDER BY bucket`
          : `SELECT strftime('${format}',${column}/1000,'unixepoch') AS bucket,COUNT(*) AS count FROM ${table} WHERE ${column}>=? AND ${column}<? AND ${condition} GROUP BY bucket ORDER BY bucket`,
      ).bind(text ? from : start, text ? to : end),
    ),
  );
  if (results.length !== definitions.length) throw new Error("Incomplete series aggregate");
  const buckets: string[] = [];
  for (let t = start; t < end;) {
    const d = new Date(t),
      key = bucket === "day" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 7);
    if (!buckets.includes(key)) buckets.push(key);
    t = bucket === "day" ? t + 86400000 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return reply(request, {
    generatedAt: now,
    timezone: "UTC",
    from,
    to,
    bucket,
    cohort: "all retained rows; no current-status reinterpretation",
    series: definitions.map(([metric, table, column], i) => {
      const values = new Map(results[i]!.results.map((row) => [row.bucket, row.count]));
      return {
        metric,
        source: `${table}.${column}`,
        points: buckets.map((key) => ({ bucket: key, count: values.get(key) ?? 0 })),
        basis:
          metric === "moderationDecisions"
            ? "recorded terminal decision events"
            : metric === "moderationCasesLatestCompleted"
              ? "latest stored case completion timestamp, not every historical completion"
              : "retained creation timestamps",
      };
    }),
    activity: {
      historicalSeriesAvailable: false,
      basis: "only latest visit per user retained; use current snapshot or latest-visit window distribution",
    },
  });
}
