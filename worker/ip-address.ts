export interface RequestIpMetadata {
  countryCode: string | null;
  ipAddress: string | null;
  regionCode: string | null;
  regionName: string | null;
}

const validIpv4 = (value: string): boolean => {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number(part) >= 0 && Number(part) <= 255 && String(Number(part)) === part,
    )
  );
};

const validIpv6 = (value: string): boolean => {
  if (value.length < 2 || value.length > 45 || !value.includes(":") || !/^[0-9a-f:.]+$/iu.test(value)) return false;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]");
  } catch {
    return false;
  }
};

const validIpAddress = (value: string): boolean => validIpv4(value) || validIpv6(value);

const headerIpAddress = (request: Request): string | null => {
  // When Cloudflare Pseudo IPv4 overwrites CF-Connecting-IP, this header keeps
  // the original IPv6 address. Both headers are set by Cloudflare, not read
  // from X-Forwarded-For.
  const candidates = [request.headers.get("CF-Connecting-IPv6"), request.headers.get("CF-Connecting-IP")];
  for (const candidate of candidates) {
    const value = candidate?.trim() ?? "";
    if (value && validIpAddress(value)) return value;
  }
  return null;
};

const cfString = (request: Request, key: "country" | "region" | "regionCode"): string | null => {
  const cf = request.cf && typeof request.cf === "object" ? request.cf : null;
  const value = cf ? Reflect.get(cf, key) : null;
  return typeof value === "string" ? value.normalize("NFKC").trim() || null : null;
};

export const requestIpMetadata = (request: Request): RequestIpMetadata => {
  const rawCountryCode = cfString(request, "country")?.toUpperCase() ?? null;
  const countryCode =
    rawCountryCode && (/^[A-Z]{2}$/u.test(rawCountryCode) || rawCountryCode === "T1") ? rawCountryCode : null;
  const rawRegionCode = cfString(request, "regionCode")?.toUpperCase() ?? null;
  const regionCode = countryCode && rawRegionCode && /^[A-Z0-9-]{1,16}$/u.test(rawRegionCode) ? rawRegionCode : null;
  const rawRegionName = cfString(request, "region");
  const regionName = rawRegionName && [...rawRegionName].length <= 120 ? rawRegionName : null;
  return {
    countryCode,
    ipAddress: headerIpAddress(request),
    regionCode,
    regionName,
  };
};
