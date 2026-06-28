import { svg as alpineLinuxSvg } from "@thesvg/icons/alpine-linux";
import { svg as androidSvg } from "@thesvg/icons/android";
import { variants as appleVariants } from "@thesvg/icons/apple";
import { svg as arcSvg } from "@thesvg/icons/arc";
import { svg as archLinuxSvg } from "@thesvg/icons/archlinux";
import { svg as blackberrySvg } from "@thesvg/icons/blackberry";
import { svg as braveSvg } from "@thesvg/icons/brave";
import { svg as centosSvg } from "@thesvg/icons/centos";
import { svg as chromeSvg } from "@thesvg/icons/chrome";
import { svg as chromiumSvg } from "@thesvg/icons/chromium";
import { svg as debianSvg } from "@thesvg/icons/debian";
import { svg as duckDuckGoSvg } from "@thesvg/icons/duckduckgo";
import { svg as electronSvg } from "@thesvg/icons/electron";
import { svg as elementarySvg } from "@thesvg/icons/elementary";
import { svg as fedoraSvg } from "@thesvg/icons/fedora";
import { svg as firefoxSvg } from "@thesvg/icons/firefox";
import { svg as floorpSvg } from "@thesvg/icons/floorp";
import { svg as freeBsdSvg } from "@thesvg/icons/freebsd";
import { svg as fuchsiaSvg } from "@thesvg/icons/fuchsia";
import { svg as gentooSvg } from "@thesvg/icons/gentoo";
import { svg as grapheneOsSvg } from "@thesvg/icons/grapheneos";
import { svg as haikuSvg } from "@thesvg/icons/haiku";
import { svg as harmonyOsSvg } from "@thesvg/icons/harmonyos";
import { svg as heliumSvg } from "@thesvg/icons/helium-browser";
import { svg as internetExplorerSvg } from "@thesvg/icons/internetexplorer";
import { svg as kaiOsSvg } from "@thesvg/icons/kaios";
import { svg as kaliLinuxSvg } from "@thesvg/icons/kali-linux";
import { svg as libreWolfSvg } from "@thesvg/icons/librewolf";
import { svg as lineageOsSvg } from "@thesvg/icons/lineageos";
import { svg as linuxSvg } from "@thesvg/icons/linux";
import { svg as linuxMintSvg } from "@thesvg/icons/linux-mint";
import { svg as manjaroSvg } from "@thesvg/icons/manjaro";
import { svg as microsoftEdgeSvg } from "@thesvg/icons/microsoft-edge";
import { svg as microsoftWindowsSvg } from "@thesvg/icons/microsoft-windows";
import { svg as netBsdSvg } from "@thesvg/icons/netbsd";
import { svg as openBsdSvg } from "@thesvg/icons/openbsd";
import { svg as openSuseSvg } from "@thesvg/icons/opensuse";
import { svg as operaSvg } from "@thesvg/icons/opera";
import { svg as operaGxSvg } from "@thesvg/icons/opera-gx";
import { svg as safariSvg } from "@thesvg/icons/safari";
import { svg as sailfishSvg } from "@thesvg/icons/sailfish-os";
import { svg as samsungBrowserSvg } from "@thesvg/icons/samsung-browser";
import { svg as torSvg } from "@thesvg/icons/tor";
import { svg as ubuntuSvg } from "@thesvg/icons/ubuntu";
import { svg as vivaldiSvg } from "@thesvg/icons/vivaldi";
import { svg as wearOsSvg } from "@thesvg/icons/wearos";
import { svg as yandexSvg } from "@thesvg/icons/yandex";
import { svg as zenBrowserSvg } from "@thesvg/icons/zen-browser";
import type { CommunityBrowserFamily, CommunityOsFamily } from "~/types/community";

const svgDataUrl = (source: string): string => `data:image/svg+xml,${encodeURIComponent(source)}`;

const appleIcon = svgDataUrl(appleVariants.light || appleVariants.mono || appleVariants.default || "");
const chromeIcon = svgDataUrl(chromeSvg);

export const COMMUNITY_OS_ICON_URLS: Readonly<Partial<Record<CommunityOsFamily, string>>> = {
  alpine_linux: svgDataUrl(alpineLinuxSvg),
  android: svgDataUrl(androidSvg),
  arch_linux: svgDataUrl(archLinuxSvg),
  blackberry: svgDataUrl(blackberrySvg),
  centos: svgDataUrl(centosSvg),
  chromeos: chromeIcon,
  debian: svgDataUrl(debianSvg),
  elementary: svgDataUrl(elementarySvg),
  fedora: svgDataUrl(fedoraSvg),
  freebsd: svgDataUrl(freeBsdSvg),
  fuchsia: svgDataUrl(fuchsiaSvg),
  gentoo: svgDataUrl(gentooSvg),
  grapheneos: svgDataUrl(grapheneOsSvg),
  haiku: svgDataUrl(haikuSvg),
  harmonyos: svgDataUrl(harmonyOsSvg),
  ios: appleIcon,
  kaios: svgDataUrl(kaiOsSvg),
  kali_linux: svgDataUrl(kaliLinuxSvg),
  lineageos: svgDataUrl(lineageOsSvg),
  linux: svgDataUrl(linuxSvg),
  linux_mint: svgDataUrl(linuxMintSvg),
  macos: appleIcon,
  manjaro: svgDataUrl(manjaroSvg),
  netbsd: svgDataUrl(netBsdSvg),
  openbsd: svgDataUrl(openBsdSvg),
  opensuse: svgDataUrl(openSuseSvg),
  sailfish: svgDataUrl(sailfishSvg),
  ubuntu: svgDataUrl(ubuntuSvg),
  wear_os: svgDataUrl(wearOsSvg),
  windows: svgDataUrl(microsoftWindowsSvg),
};

export const COMMUNITY_BROWSER_ICON_URLS: Readonly<Partial<Record<CommunityBrowserFamily, string>>> = {
  arc: svgDataUrl(arcSvg),
  brave: svgDataUrl(braveSvg),
  chrome: chromeIcon,
  chromium: svgDataUrl(chromiumSvg),
  duckduckgo: svgDataUrl(duckDuckGoSvg),
  edge: svgDataUrl(microsoftEdgeSvg),
  electron: svgDataUrl(electronSvg),
  firefox: svgDataUrl(firefoxSvg),
  floorp: svgDataUrl(floorpSvg),
  helium: svgDataUrl(heliumSvg),
  internet_explorer: svgDataUrl(internetExplorerSvg),
  librewolf: svgDataUrl(libreWolfSvg),
  opera: svgDataUrl(operaSvg),
  opera_gx: svgDataUrl(operaGxSvg),
  safari: svgDataUrl(safariSvg),
  samsung_internet: svgDataUrl(samsungBrowserSvg),
  tor: svgDataUrl(torSvg),
  vivaldi: svgDataUrl(vivaldiSvg),
  yandex: svgDataUrl(yandexSvg),
  zen: svgDataUrl(zenBrowserSvg),
};
