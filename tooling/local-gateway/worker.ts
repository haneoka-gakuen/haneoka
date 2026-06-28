import { handleBestdoriProxy } from "../../worker/bestdori";

const cors = {
  "Access-Control-Allow-Headers": "Content-Type, If-None-Match, If-Range, Range",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Origin": "*",
} as const;

export default {
  async fetch(request: Request, _env: unknown, context: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: { code: "method_not_allowed", message: "Only GET and HEAD are available locally" } },
        { status: 405, headers: cors },
      );
    }
    const response = await handleBestdoriProxy(context, request, new URL(request.url));
    return (
      response ??
      Response.json(
        { error: { code: "route_not_found", message: "The local Bestdori route does not exist" } },
        { status: 404, headers: cors },
      )
    );
  },
};
