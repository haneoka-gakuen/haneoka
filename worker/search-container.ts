// L3 — GEB
// Input: Search index HTTP requests from the Worker.
// Output: A Meilisearch container whose API key never leaves this Durable Object.
// Pos: [Map](L2.md); container host for search-index.ts.
// Effects/Dependencies: Starts the container; the index lives on its disk and is rebuilt by the search sync.
import { Container } from "@cloudflare/containers";

export class SearchContainer extends Container<Env> {
  override defaultPort = 7700;
  override sleepAfter = "2h";
  override enableInternet = false;
  private token = "";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.token = (await ctx.storage.get<string>("masterKey")) || "";
      if (!this.token) {
        this.token = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        await ctx.storage.put("masterKey", this.token);
      }
      this.envVars = { MEILI_MASTER_KEY: this.token };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.containerFetch(new Request(request, { headers }));
  }
}
