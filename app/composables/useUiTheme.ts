export const UI_THEME_STORAGE_KEY = "haneoka.ui-theme.v1";

export type UiThemePreference = "light" | "system" | "dark";
export type ResolvedUiTheme = Exclude<UiThemePreference, "system">;

const isUiThemePreference = (value: unknown): value is UiThemePreference =>
  value === "light" || value === "system" || value === "dark";

const readStoredTheme = (): UiThemePreference => {
  if (!import.meta.client) return "light";
  try {
    const stored = localStorage.getItem(UI_THEME_STORAGE_KEY);
    return isUiThemePreference(stored) ? stored : "light";
  } catch {
    return "light";
  }
};

const systemTheme = (): ResolvedUiTheme =>
  import.meta.client && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const resolveTheme = (preference: UiThemePreference): ResolvedUiTheme =>
  preference === "system" ? systemTheme() : preference;

const persistTheme = (preference: UiThemePreference) => {
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, preference);
  } catch {
    // The selected theme still remains active for this browser session.
  }
};

const applyTheme = (preference: UiThemePreference, resolved: ResolvedUiTheme) => {
  if (!import.meta.client) return;
  const root = document.documentElement;
  root.dataset.uiTheme = preference;
  root.dataset.uiResolvedTheme = resolved;
  root.style.colorScheme = resolved;
};

let mediaQuery: MediaQueryList | undefined;
let mediaListener: ((event: MediaQueryListEvent) => void) | undefined;

export const useUiTheme = () => {
  const themePreference = useState<UiThemePreference>("ui-theme-preference", () => "light");
  const resolvedTheme = useState<ResolvedUiTheme>("ui-theme-resolved", () => "light");
  const ready = useState("ui-theme-ready", () => false);
  const observing = useState("ui-theme-observing", () => false);

  if (import.meta.client && !ready.value) {
    themePreference.value = readStoredTheme();
    resolvedTheme.value = resolveTheme(themePreference.value);
    ready.value = true;
  }

  if (import.meta.client && !observing.value) {
    observing.value = true;
    watch(
      themePreference,
      (preference) => {
        resolvedTheme.value = resolveTheme(preference);
        persistTheme(preference);
        applyTheme(preference, resolvedTheme.value);
      },
      { immediate: true },
    );

    mediaQuery ??= window.matchMedia("(prefers-color-scheme: dark)");
    mediaListener ??= () => {
      if (themePreference.value !== "system") return;
      resolvedTheme.value = systemTheme();
      applyTheme(themePreference.value, resolvedTheme.value);
    };
    mediaQuery.addEventListener("change", mediaListener);
  }

  const setThemePreference = (value: unknown) => {
    if (isUiThemePreference(value)) themePreference.value = value;
  };

  return {
    themePreference: readonly(themePreference),
    resolvedTheme: readonly(resolvedTheme),
    setThemePreference,
  };
};
