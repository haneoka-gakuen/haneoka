import { defaultStampText, type StampText } from "./render";
import type { StampCharacterColor } from "./colors";
export interface StampImageTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface StampLayer {
  id: string;
  image?: StampImageTransform;
  settings: StampText;
  colorCharacter: string;
  backgroundCharacter: string;
  colorWasChosen: boolean;
  localFontLabel?: string;
}
export function copyStampText(text: StampText): StampText {
  return {
    ...text,
    frame: text.frame ? { ...text.frame } : undefined,
    background: text.background ? { ...text.background } : undefined,
  };
}
export function createStampLayer(text = defaultStampText()): StampLayer {
  return {
    id: `stamp-layer-${crypto.randomUUID()}`,
    settings: copyStampText(text),
    colorCharacter: "custom",
    backgroundCharacter: "custom",
    colorWasChosen: false,
  };
}

export function createStampImageLayer(): StampLayer {
  return {
    ...createStampLayer({ ...defaultStampText(), text: "", font: "auto" }),
    image: { x: 50, y: 50, scale: 100, rotation: 0 },
  };
}

/** Apply a confirmed stamp character's foreground color without changing the composition. */
export function recolorStampTextLayers(
  layers: readonly StampLayer[],
  character: Pick<StampCharacterColor, "id" | "color">,
): StampLayer[] {
  return layers.map((layer) =>
    layer.image
      ? layer
      : {
          ...layer,
          settings: copyStampText({ ...layer.settings, fill: character.color }),
          colorCharacter: character.id,
          colorWasChosen: false,
        },
  );
}
