import { html } from "lit";
import { resolveLocalizedText } from "../../lib/localized-text";
import { localizedText, readPath } from "../shared/catalog";
import { tile } from "./tile";
import { icon } from "./icon";
import { nextImageCandidate } from "./lazy-images";
import "../../styles/model-tile.css";

type Model = Record<string, unknown>;
export function modelPreviewSources(model: Model): string[] {
  return [readPath(model, "preview.image"), readPath(model, "preview.runtime"), model.thumbnailImage, model.faceImage]
    .filter((value): value is string => typeof value === "string" && Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
}
export function modelTitle(model: Model, locale: string) {
  return resolveLocalizedText(model.title || model.live2dName || model.characterName || model.live2dKey || "", locale);
}
export function modelTile(options: {
  model: Model;
  character?: Model;
  locale: string;
  href?: string;
  onOpen?: () => void;
}) {
  const { model, character, locale } = options;
  const title = modelTitle(model, locale);
  const images = modelPreviewSources(model);
  const face = String(character?.faceImage || model.faceImage || "");
  return tile({
    kind: "model",
    title: title.text,
    titleLanguage: title.locale,
    subtitle:
      localizedText(model.characterName || character?.characterName, locale) ||
      String(model.characterKey || model.live2dKey || ""),
    adornment: face
      ? html`
          <img src=${face} alt="" width="16" height="16" loading="lazy" />
        `
      : undefined,
    label: title.text,
    image: images[0] || "",
    imageCandidates: images,
    placeholder: icon("animation", 32),
    natural: false,
    fit: "contain",
    href: options.href,
    onOpen: options.onOpen,
    onImageError: nextImageCandidate,
  });
}
