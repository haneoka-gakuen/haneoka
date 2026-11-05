import { siteOrigin } from "../lib/site-origin";

export const sonolusServerLink = () => `https://open.sonolus.com/${new URL(siteOrigin()).host}`;
