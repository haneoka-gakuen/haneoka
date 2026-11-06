import { clientText } from "../../i18n/client";
import { emptyState } from "./state";

export function unpublishedState(locale: string) {
  return emptyState({
    title: clientText(locale, "common.states.unpublished"),
    body: clientText(locale, "common.states.unpublishedDescription"),
    icon: "visibility_off",
  });
}
