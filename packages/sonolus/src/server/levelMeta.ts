// Pure master-data → Sonolus level metadata mapping. One descriptor per
// (music × difficulty); feeds the pack/server step (which attaches cover/bgm/data
// SRLs + the engine ref). No I/O — takes already-parsed master tables.
//
// Sources (data/master/decoded/): MasterLiveMusic (_titleTextID, _bandIDs,
// _bandNameTextID, _jacketAssetName, _musicSoundID, _easyID.._expertID →
// MasterLiveMusicScore._id, _liveScoreRankGroup), MasterLiveMusicScore
// (_musicScoreTextFileName, _musicScoreLevel, _fullComboCount), MasterBand
// (_nameTextID), MasterText (id → localized string).

export type Difficulty = "easy" | "normal" | "hard" | "expert";

export interface MusicRow {
  _id: number;
  _titleTextID: string;
  _bandIDs?: number[];
  _bandNameTextID?: string;
  _lyricistTextID: string;
  _composerTextID: string;
  _arrangerTextID: string;
  _jacketAssetName: string;
  _musicSoundID: number;
  _liveScoreRankGroup: number;
  _easyID: number;
  _normalID: number;
  _hardID: number;
  _expertID: number;
}
export interface ScoreRow {
  _id: number;
  _musicScoreTextFileName: string;
  _musicScoreLevel: number;
  _fullComboCount: number;
}
export interface BandRow {
  _id: number;
  _nameTextID: string;
}
export interface TextRow {
  _id: string;
  _japanese: string;
  _english: string;
  _simplifiedChinese: string;
  _traditionalChinese: string;
  _korean: string;
}
export type Locale = "_japanese" | "_english" | "_simplifiedChinese" | "_traditionalChinese" | "_korean";

export interface LevelMeta {
  name: string; // unique level id
  musicId: number;
  difficulty: Difficulty;
  scoreId: number;
  chartFile: string; // e.g. "0001/0001_03"
  title: string;
  artists: string;
  rating: number;
  fullComboCount: number;
  jacketAsset: string;
  musicSoundId: number;
  rankGroup: number;
}

const DIFFS: { key: Difficulty; idField: keyof MusicRow }[] = [
  { key: "easy", idField: "_easyID" },
  { key: "normal", idField: "_normalID" },
  { key: "hard", idField: "_hardID" },
  { key: "expert", idField: "_expertID" },
];

export function makeTextResolver(texts: TextRow[], locale: Locale = "_japanese"): (id: string) => string {
  const byId = new Map<string, TextRow>();
  for (const t of texts) byId.set(t._id, t);
  return (id: string) => {
    const row = byId.get(id);
    if (!row) return "";
    return row[locale] || row._japanese || row._english || "";
  };
}

export function buildLevelMetas(
  music: MusicRow[],
  scores: ScoreRow[],
  texts: TextRow[],
  locale: Locale = "_japanese",
  bands: BandRow[] = [],
): LevelMeta[] {
  const scoreById = new Map<number, ScoreRow>();
  for (const s of scores) scoreById.set(s._id, s);
  const bandById = new Map<number, BandRow>();
  for (const b of bands) bandById.set(b._id, b);
  const text = makeTextResolver(texts, locale);

  const out: LevelMeta[] = [];
  for (const m of music) {
    const title = text(m._titleTextID);
    const artists =
      (m._bandNameTextID && text(m._bandNameTextID)) ||
      [...new Set(m._bandIDs ?? [])]
        .map((id) => {
          const band = bandById.get(id);
          return band ? text(band._nameTextID) : "";
        })
        .filter(Boolean)
        .join(" / ") ||
      text(m._composerTextID) ||
      text(m._lyricistTextID) ||
      text(m._arrangerTextID) ||
      "";
    for (const d of DIFFS) {
      const scoreId = m[d.idField] as number;
      if (!scoreId) continue;
      const score = scoreById.get(scoreId);
      if (!score) continue;
      out.push({
        name: `ourNotes-${m._id}-${d.key}`,
        musicId: m._id,
        difficulty: d.key,
        scoreId,
        chartFile: score._musicScoreTextFileName,
        title,
        artists,
        rating: score._musicScoreLevel,
        fullComboCount: score._fullComboCount,
        jacketAsset: m._jacketAssetName,
        musicSoundId: m._musicSoundID,
        rankGroup: m._liveScoreRankGroup,
      });
    }
  }
  return out;
}
