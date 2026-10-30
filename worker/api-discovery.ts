// L3 — GEB
// Input: 公共 API 根路径。
// Output: API、目录和本地计算入口。
// Pos: [Map](L2.md)；人和 Agent 共用的能力发现入口。
// Effects/Dependencies: 静态 JSON；完整 OpenAPI 从同次部署的 ASSETS 读取。
export async function handleApiDiscovery(request: Request, assets?: Pick<Fetcher, "fetch">): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["/api/v1", "/api/v1/", "/api/v1/openapi.json", "/api/v1/tools"].includes(url.pathname)) return null;
  const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!["GET", "HEAD"].includes(request.method)) return Response.json({ error: { code: "method_not_allowed", message: "Use GET or HEAD" } }, { status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" } });
  if (url.pathname === "/api/v1/openapi.json") {
    if (!assets) return Response.json({ error: { code: "schema_unavailable", message: "API schema is unavailable" } }, { status: 503, headers });
    const response = await assets.fetch(new Request(new URL("/api/openapi.json", url), { method: request.method }));
    return new Response(response.body, { status: response.status, headers });
  }
  const tools = {
    apiClient: "/tools/api-client.js", schema: "/tools/schema.json",
    manifest: "/tools/manifest.json", stylesheet: "/tools/fonts.css",
    teamBuilder: { module: "/tools/team-builder.js", data: "/api/v1/team-builder/{server}", methods: ["run", "evaluate", "growth", "explain", "cancel", "dispose"] },
    images: { module: "/tools/images.js", methods: ["renderResourceImage", "requestResourceImage", "parseChartScore"], stylesheet: "/tools/image-theme.css", routes: "/api/v1/openapi.json" },
    chartImage: { module: "/tools/chart-image.js", method: "renderChartImage" },
    gacha: { module: "/tools/gacha.js", methods: ["simulateGacha", "canSimulate", "gachaGuarantee", "tallyGacha"] },
    songPuzzle: { module: "/tools/song-puzzle.js", method: "solvePuzzle" },
    stamp: { module: "/tools/stamp.js", methods: ["drawStamp", "defaultStampText", "loadStampFont", "createStampLayer", "createStampImageLayer", "stampOutputSize"] },
    localService: { base: "http://127.0.0.1:8765/v1", jobs: "/v1/jobs", images: "/v1/resource-image", methods: ["GET", "POST", "DELETE"] },
  };
  const body = url.pathname === "/api/v1/tools" ? tools : {
    version: "v1", documentation: "https://docs.haneoka.org/", openapi: "/api/v1/openapi.json",
    releases: "/api/v1/releases", catalog: "/api/v1/servers/{server}/catalog", tools,
  };
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), { headers });
}
