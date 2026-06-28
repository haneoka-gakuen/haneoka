interface AdminErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

export class AdminApiError extends Error {
  readonly code: string | null;
  readonly status: number;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const errorPayload = (value: unknown): AdminErrorPayload | null => {
  if (!isObject(value) || !isObject(value.error)) return null;
  return value as AdminErrorPayload;
};

export const adminIdempotencyKey = (): string => `admin-${crypto.randomUUID()}`;

export const adminMutationHeaders = (): Record<string, string> => ({
  "Idempotency-Key": adminIdempotencyKey(),
});

export const readAdminResponse = async <T>(response: Response): Promise<T> => {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const payload = errorPayload(value);
    throw new AdminApiError(
      response.status,
      payload?.error?.code ?? null,
      payload?.error?.message || `Admin request failed (${response.status})`,
    );
  }
  return value as T;
};
