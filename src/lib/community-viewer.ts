import { fetchJson, JsonResponseError } from "../lit/shared/catalog";

type Value = Record<string, unknown>;
export interface CommunityViewer {
  session: Value | null;
  userId: string;
  staffRole: "admin" | "moderator" | null;
  realm: string;
}

export class CommunityRealmChanged extends Error {
  constructor() {
    super("Community identity changed");
    this.name = "CommunityRealmChanged";
  }
}

/** The existing authoritative session/staff APIs define the current read realm. */
export async function readCommunityViewer(signal: AbortSignal): Promise<CommunityViewer> {
  const init: RequestInit = { credentials: "same-origin", cache: "no-store", signal };
  const sessionRead = fetchJson<Value | null>("/api/auth/get-session", init);
  // Catch immediately: an anonymous session does not need the staff response.
  const staffRead = fetchJson<Value>("/api/v1/admin/session", init).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const session = await sessionRead;
  signal.throwIfAborted();
  const user = session?.user as Value | undefined;
  const userId = typeof user?.id === "string" ? user.id : "";
  let staffRole: CommunityViewer["staffRole"] = null;
  if (userId) {
    try {
      const result = await staffRead;
      signal.throwIfAborted();
      if (!result.ok) throw result.error;
      const staff = result.value.session as Value | undefined;
      const staffId = (staff?.user as Value | undefined)?.id;
      if (staffId !== userId) throw new CommunityRealmChanged();
      if (staff?.role === "admin" || staff?.role === "moderator") staffRole = staff.role;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof JsonResponseError && error.status === 401)
        return { session: null, userId: "", staffRole: null, realm: JSON.stringify(["", null]) };
      if (!(error instanceof JsonResponseError) || error.status !== 403) throw error;
    }
  }
  return {session: userId ? session : null, userId, staffRole, realm: JSON.stringify([userId, staffRole])};
}
