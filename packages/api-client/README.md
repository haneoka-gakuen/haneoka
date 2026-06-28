# `@haneoka/api-client`

Small, host-neutral HTTP infrastructure for Haneoka packages and applications.
It owns URL/query normalization, caller-driven cancellation, JSON content validation and
structured errors. A custom `transport(Request)` can be injected for Workers,
Node gateways, tests, or non-Fetch hosts.

The package has no Vue, Nuxt, Worker, database, or Haneoka route dependency.

```ts
import { createApiClient } from "@haneoka/api-client";

const api = createApiClient({ baseUrl: "https://example.test/api/v1" });
const songs = await api.get<Record<string, Song>>("servers/jp/songs");
```
