export type BrowserFamily =
  | "arc"
  | "bot"
  | "brave"
  | "chrome"
  | "chromium"
  | "duckduckgo"
  | "edge"
  | "electron"
  | "firefox"
  | "floorp"
  | "helium"
  | "internet_explorer"
  | "librewolf"
  | "opera"
  | "opera_gx"
  | "other"
  | "safari"
  | "samsung_internet"
  | "tor"
  | "unknown"
  | "vivaldi"
  | "webview"
  | "yandex"
  | "zen";

export type OsFamily =
  | "alpine_linux"
  | "android"
  | "arch_linux"
  | "blackberry"
  | "centos"
  | "chromeos"
  | "debian"
  | "elementary"
  | "fedora"
  | "freebsd"
  | "fuchsia"
  | "gentoo"
  | "grapheneos"
  | "haiku"
  | "harmonyos"
  | "ios"
  | "kaios"
  | "kali_linux"
  | "lineageos"
  | "linux"
  | "linux_mint"
  | "macos"
  | "manjaro"
  | "netbsd"
  | "openbsd"
  | "opensuse"
  | "other"
  | "sailfish"
  | "ubuntu"
  | "unknown"
  | "wear_os"
  | "windows";

export interface RequestClientMetadata {
  browserFamily: BrowserFamily;
  osFamily: OsFamily;
  userAgent: string | null;
}

const USER_AGENT_MAX = 1_024;

const rawUserAgent = (request: Request): string | null => {
  const value = request.headers.get("User-Agent")?.trim() ?? "";
  return value ? value.slice(0, USER_AGENT_MAX) : null;
};

const clientHint = (request: Request, name: "Sec-CH-UA" | "Sec-CH-UA-Platform"): string =>
  (request.headers.get(name) ?? "").trim().toLowerCase();

const browserFromHint = (hint: string): BrowserFamily | null => {
  if (!hint) return null;
  if (hint.includes("opera gx")) return "opera_gx";
  if (hint.includes("samsung internet")) return "samsung_internet";
  if (hint.includes("duckduckgo")) return "duckduckgo";
  if (hint.includes("tor browser")) return "tor";
  if (hint.includes("zen browser")) return "zen";
  if (hint.includes("helium")) return "helium";
  if (hint.includes("librewolf")) return "librewolf";
  if (hint.includes("vivaldi")) return "vivaldi";
  if (hint.includes("yandex")) return "yandex";
  if (hint.includes("floorp")) return "floorp";
  if (hint.includes("brave")) return "brave";
  if (hint.includes("arc")) return "arc";
  if (hint.includes("microsoft edge")) return "edge";
  if (hint.includes("opera")) return "opera";
  if (hint.includes("google chrome")) return "chrome";
  if (hint.includes("chromium")) return "chromium";
  return null;
};

const specificBrowserFromUserAgent = (userAgent: string | null): BrowserFamily | null => {
  if (!userAgent) return null;
  if (/\b(bot|crawler|spider|slurp|bingpreview|facebookexternalhit)\b/iu.test(userAgent)) return "bot";
  if (/\b(?:OPRGX|Opera GX)(?:\/|\s)/iu.test(userAgent)) return "opera_gx";
  if (/\bSamsungBrowser\//u.test(userAgent)) return "samsung_internet";
  if (/\bDuckDuckGo\//iu.test(userAgent)) return "duckduckgo";
  if (/\b(?:TorBrowser|Tor Browser)(?:\/|\s)/iu.test(userAgent)) return "tor";
  if (/\b(?:ZenBrowser|Zen Browser|Zen)\//iu.test(userAgent)) return "zen";
  if (/\bHelium\//iu.test(userAgent)) return "helium";
  if (/\bLibreWolf\//iu.test(userAgent)) return "librewolf";
  if (/\bVivaldi\//iu.test(userAgent)) return "vivaldi";
  if (/\bYaBrowser\//iu.test(userAgent)) return "yandex";
  if (/\bFloorp\//iu.test(userAgent)) return "floorp";
  if (/\bBrave\//iu.test(userAgent)) return "brave";
  if (/\bArc(?:Mobile)?\//iu.test(userAgent)) return "arc";
  if (/\bElectron\//iu.test(userAgent)) return "electron";
  if (/\b(?:MSIE\s|Trident\/.*\brv:)/iu.test(userAgent)) return "internet_explorer";
  if (/\bEdg(?:A|iOS)?\//u.test(userAgent)) return "edge";
  if (/\b(?:OPR|Opera)(?:\/|\s)/u.test(userAgent)) return "opera";
  if (/;\s*wv\)/iu.test(userAgent) || /\b(?:Android System WebView|WebView)\//iu.test(userAgent)) return "webview";
  return null;
};

const browserFromUserAgent = (userAgent: string | null): BrowserFamily => {
  if (!userAgent) return "unknown";
  if (/\b(?:FxiOS|Firefox)\//u.test(userAgent)) return "firefox";
  if (/\b(?:CriOS|Chrome)\//u.test(userAgent)) return "chrome";
  if (/\bChromium\//u.test(userAgent)) return "chromium";
  if (/\bSafari\//u.test(userAgent) && /\bVersion\//u.test(userAgent)) return "safari";
  return "other";
};

const osFromHint = (hint: string): OsFamily | null => {
  const platform = hint.replace(/^"|"$/gu, "");
  switch (platform) {
    case "alpine linux":
      return "alpine_linux";
    case "android":
      return "android";
    case "arch linux":
      return "arch_linux";
    case "blackberry":
    case "blackberry os":
      return "blackberry";
    case "centos":
      return "centos";
    case "chrome os":
      return "chromeos";
    case "debian":
      return "debian";
    case "elementary os":
      return "elementary";
    case "fedora":
      return "fedora";
    case "freebsd":
      return "freebsd";
    case "fuchsia":
      return "fuchsia";
    case "gentoo":
      return "gentoo";
    case "grapheneos":
      return "grapheneos";
    case "haiku":
      return "haiku";
    case "harmonyos":
      return "harmonyos";
    case "ios":
      return "ios";
    case "kaios":
      return "kaios";
    case "kali linux":
      return "kali_linux";
    case "lineageos":
      return "lineageos";
    case "linux":
      return "linux";
    case "linux mint":
      return "linux_mint";
    case "macos":
      return "macos";
    case "manjaro":
      return "manjaro";
    case "netbsd":
      return "netbsd";
    case "openbsd":
      return "openbsd";
    case "opensuse":
      return "opensuse";
    case "sailfish os":
      return "sailfish";
    case "ubuntu":
      return "ubuntu";
    case "wear os":
      return "wear_os";
    case "windows":
      return "windows";
    default:
      return null;
  }
};

const specificOsFromUserAgent = (userAgent: string | null): OsFamily | null => {
  if (!userAgent) return null;
  if (/\bGrapheneOS\b/iu.test(userAgent)) return "grapheneos";
  if (/\bLineageOS\b/iu.test(userAgent)) return "lineageos";
  if (/\bHarmonyOS\b/iu.test(userAgent)) return "harmonyos";
  if (/\bWear OS\b/iu.test(userAgent)) return "wear_os";
  if (/\bFuchsia\b/iu.test(userAgent)) return "fuchsia";
  if (/\bSailfish(?:\s*OS)?\b/iu.test(userAgent)) return "sailfish";
  if (/\b(?:BB10|BlackBerry|PlayBook)\b/iu.test(userAgent)) return "blackberry";
  if (/\bKaiOS\b/iu.test(userAgent)) return "kaios";
  if (/\bCrOS\b/u.test(userAgent)) return "chromeos";
  if (/\bFreeBSD\b/iu.test(userAgent)) return "freebsd";
  if (/\bOpenBSD\b/iu.test(userAgent)) return "openbsd";
  if (/\bNetBSD\b/iu.test(userAgent)) return "netbsd";
  if (/\bAlpine(?:\s+Linux)?\b/iu.test(userAgent)) return "alpine_linux";
  if (/\bArch(?:\s+Linux)?\b/iu.test(userAgent)) return "arch_linux";
  if (/\bCentOS\b/iu.test(userAgent)) return "centos";
  if (/\bDebian\b/iu.test(userAgent)) return "debian";
  if (/\belementary(?:\s+OS)?\b/iu.test(userAgent)) return "elementary";
  if (/\bFedora\b/iu.test(userAgent)) return "fedora";
  if (/\bGentoo\b/iu.test(userAgent)) return "gentoo";
  if (/\bHaiku\b/iu.test(userAgent)) return "haiku";
  if (/\bKali(?:\s+Linux)?\b/iu.test(userAgent)) return "kali_linux";
  if (/\bLinux Mint\b/iu.test(userAgent)) return "linux_mint";
  if (/\bManjaro\b/iu.test(userAgent)) return "manjaro";
  if (/\b(?:openSUSE|SUSE)\b/iu.test(userAgent)) return "opensuse";
  if (/\bUbuntu\b/iu.test(userAgent)) return "ubuntu";
  if (/\b(?:iPhone|iPad|iPod)\b/u.test(userAgent)) return "ios";
  return null;
};

const osFromUserAgent = (userAgent: string | null): OsFamily => {
  if (!userAgent) return "unknown";
  if (/\bWindows(?: NT| Phone)?\b/u.test(userAgent)) return "windows";
  if (/\bAndroid\b/u.test(userAgent)) return "android";
  if (/\bMacintosh\b|\bMac OS X\b/u.test(userAgent)) return "macos";
  if (/\bLinux\b|\bX11\b/u.test(userAgent)) return "linux";
  return "other";
};

export const requestClientMetadata = (request: Request): RequestClientMetadata => {
  const userAgent = rawUserAgent(request);
  return {
    browserFamily:
      specificBrowserFromUserAgent(userAgent) ??
      browserFromHint(clientHint(request, "Sec-CH-UA")) ??
      browserFromUserAgent(userAgent),
    osFamily:
      specificOsFromUserAgent(userAgent) ??
      osFromHint(clientHint(request, "Sec-CH-UA-Platform")) ??
      osFromUserAgent(userAgent),
    userAgent,
  };
};
