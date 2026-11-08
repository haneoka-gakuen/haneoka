import { Container } from "@cloudflare/containers";

export class CommunityMediaContainer extends Container<Env> {
  override defaultPort = 8080;
  override sleepAfter = "60s";
  override enableInternet = false;
  private token = "";

  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.token = (await ctx.storage.get<string>("serviceToken")) || "";
      if (!this.token) {
        this.token = [...crypto.getRandomValues(new Uint8Array(32))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
        await ctx.storage.put("serviceToken", this.token);
      }
      this.envVars = { COMMUNITY_MEDIA_TOKEN: this.token, MEDIA_PROCESS_CONCURRENCY: "1" };
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    return this.containerFetch(new Request(request, { headers }));
  }
}
