/** Characters for the theme picker: band members with a chromatic colour, in band and display order. */
import { Hct, argbFromHex } from "@material/material-color-utilities";
import { fetchOptionalStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import { resolveLocalizedText } from "../lib/localized-text";
import { staticBuildJson } from "./static-input-store";
import type { ThemeCharacter } from "../lib/themes";

type Row = Record<string, unknown>;

async function rows(): Promise<Row[]> {
  const release = await staticCatalogRelease("jp");
  return staticBuildJson(`theme-characters:${release.releaseId}`, "theme-characters", async () => {
    const { value } = await fetchOptionalStaticCatalog("characters", "jp", release);
    return Object.values((value || {}) as Record<string, Row>).map((row) => ({
      characterId: row.characterId,
      characterName: row.characterName,
      bandId: row.bandId,
      displayOrder: row.displayOrder,
      colorCode: row.colorCode,
      faceImage: row.faceImage,
      birthday: row.birthday,
    }));
  });
}

export async function themeCharacters(locale: string): Promise<ThemeCharacter[]> {
  return (await rows())
    .filter(
      (row) =>
        typeof row.colorCode === "string" &&
        /^#[0-9a-f]{6}$/i.test(row.colorCode) &&
        Hct.fromInt(argbFromHex(row.colorCode)).chroma > 8 &&
        Number(row.bandId) >= 1 &&
        Number(row.bandId) <= 5,
    )
    .sort((a, b) => Number(a.bandId) - Number(b.bandId) || Number(a.displayOrder) - Number(b.displayOrder))
    .map((row) => {
      const birthday = row.birthday as { month?: number; day?: number } | undefined;
      return {
        id: Number(row.characterId),
        bandId: Number(row.bandId),
        color: String(row.colorCode),
        face: String(row.faceImage || ""),
        name: resolveLocalizedText(row.characterName, locale).text,
        birthday: birthday?.month && birthday.day ? [Number(birthday.month), Number(birthday.day)] : null,
      };
    });
}
