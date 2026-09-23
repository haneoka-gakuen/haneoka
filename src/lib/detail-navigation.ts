import { navigate } from "astro:transitions/client";

export function openDetailLocation(url: string): void {
  void navigate(url, { state: { haneokaDetail: location.pathname } });
}

export function closeDetailLocation(url: string): void {
  if (history.state?.haneokaDetail === location.pathname) history.back();
  else void navigate(url, { history: "replace" });
}
