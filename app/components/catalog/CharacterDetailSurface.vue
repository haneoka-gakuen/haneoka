<script setup lang="ts">
import type { CharacterMissionEntry } from "~/components/catalog/CharacterMissionList.vue";
import type { ResourceReferenceItem } from "~/components/catalog/ResourceReferenceList.vue";
import type { StoryCatalogListItem } from "~/components/catalog/StoryCatalogList.vue";
import type { VoiceDialogueGroup, VoiceDialogueLine } from "~/components/catalog/VoiceDialogueLines.vue";
import type { DetailHeaderIconItem, DetailPeerItem } from "~/components/detail/types";
import type {
  Band,
  Character,
  Live2DModel,
  LocalizedValue,
  MemberCard,
  Song,
  Stamp,
  StoryEpisode,
  SupportCard,
} from "~/types/archive";
import { type CatalogContentOrigin } from "~/features/catalog/contentSource";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    open: boolean;
    character?: Character;
    band?: Band;
    /** Exact Our Notes release that supplied this character detail. */
    origin: Extract<CatalogContentOrigin, { provider: "release" }>;
    title: DisplayText;
    subtitle?: DisplayText;
    pending?: boolean;
    error?: unknown;
  }>(),
  {
    character: undefined,
    band: undefined,
    subtitle: "",
    pending: false,
    error: undefined,
  },
);

const emit = defineEmits<{
  close: [];
  retry: [];
}>();

interface CharacterStoryGroup {
  id: string;
  label: string;
  media: "avatars" | "thumbnail";
  items: StoryCatalogListItem[];
}

interface VoiceSound {
  cueName?: string;
  playableUrl?: string;
}

interface VoiceSourceLine {
  characterId?: number;
  text?: LocalizedValue;
  sound?: VoiceSound;
}

interface VoiceEntry {
  voiceKey?: string;
  characterIds?: number[];
  characterVoiceTypeName?: string;
  collectionVoiceTypeName?: string;
  dialogueTypeName?: string;
  masterTypeName?: string;
  sourceTable?: string;
  text?: LocalizedValue;
  sound?: VoiceSound;
  lines?: VoiceSourceLine[];
}

interface CharacterVoiceLine {
  key: string;
  characterId: number;
  text: DisplayText;
  cue: string;
  playableUrl: string;
}

interface CharacterVoiceGroup {
  key: string;
  category: DisplayText;
  lines: CharacterVoiceLine[];
}

interface CharacterMissionDocument {
  missions?: CharacterMissionEntry[];
}

interface FriendshipEpisode {
  episodeId?: number;
  episodeNumber?: number;
  storyKey?: string;
  unlockFriendshipLevel?: number;
  banner?: string;
  advId?: number;
}

interface FriendshipRewardResource {
  image?: string;
  name?: LocalizedValue;
  kind?: string;
  itemId?: number;
}

interface FriendshipReward {
  rank?: number;
  reward?: {
    resolved?: FriendshipRewardResource;
    resourceCount?: number;
    resourceTypeName?: string;
    rewardId?: number;
  };
}

interface FriendshipEntry {
  friendshipId?: number;
  characterIds?: number[];
  ranks?: Array<{ rank?: number }>;
  rewards?: FriendshipReward[];
  episodes?: FriendshipEpisode[];
}

interface CharacterFriendship extends FriendshipEntry {
  friendshipKey: string;
}

const { resolveLocalized, t } = useLocale();
const { resolveSongTitle } = useSongTitle();
const creditOrigin = computed(() => props.origin);
const layerLink = useRouteQueryLayerLink();
const characterId = computed(() => props.character?.characterId || 0);
const headerIcons = computed<DetailHeaderIconItem[]>(() =>
  props.character
    ? [
        {
          id: props.character.characterId,
          label: props.title,
          image: props.character.faceImage || props.character.thumbnailImage || props.character.profileImage,
          shape: "avatar",
        },
      ]
    : [],
);
const relationCharacterId = computed(() => characterId.value || undefined);
const bandId = computed(() => props.character?.bandId || props.band?.bandId || 0);
const relationBandId = computed(() => bandId.value || undefined);
const { data: cardRecord } = useCatalogRelation<MemberCard>(
  "cards",
  "character",
  relationCharacterId,
  () => props.origin,
);
const { data: supportRecord } = useCatalogRelation<SupportCard>(
  "support-cards",
  "character",
  relationCharacterId,
  () => props.origin,
);
const { data: stampRecord } = useCatalogRelation<Stamp>("stamps", "character", relationCharacterId, () => props.origin);
const { data: live2dRecord } = useCatalogRelation<Live2DModel>(
  "live2d",
  "character",
  relationCharacterId,
  () => props.origin,
);
const { data: songRecord } = useCatalogRelation<Song>("songs", "band", relationBandId, () => props.origin);
const {
  data: voiceRecord,
  pending: voicePending,
  error: voiceError,
  refresh: refreshVoices,
} = useCatalogRelation<VoiceEntry>("voices", "character", relationCharacterId, () => props.origin);
const {
  data: friendshipRecord,
  pending: friendshipPending,
  error: friendshipError,
  refresh: refreshFriendships,
} = useCatalogRelation<FriendshipEntry>("friendships", "character", relationCharacterId, () => props.origin);
const {
  data: missionDocument,
  pending: missionPending,
  error: missionError,
  refresh: refreshMissions,
} = useCatalogDocument<CharacterMissionDocument>("character-missions", () => props.origin);
const {
  catalog: storyCatalog,
  characterMap,
  characters: archiveCharacters,
  bandMap,
  charactersOf,
  durationOf,
  homeSpotOfStory,
  releaseOf,
  storyTo,
} = useStoryCatalogArchive(() => props.origin);
const { playing: musicPlaying, pause: pauseMusic } = useAudioPlayer();

const resolveCharacterName = (character: Character | null | undefined, fallback: string): DisplayText => {
  if (!character) return fallback;
  return (
    resolveLocalized(character.characterName, { sourceHint: "ja" }) ||
    resolveLocalized(character.englishName, { sourceHint: "en" }) ||
    fallback
  );
};

type StoryCategory = "band" | "link" | "home" | "afterlive" | "tutorial";
const storyCategories: StoryCategory[] = ["band", "link", "home", "afterlive", "tutorial"];
const storyCategoryOf = (story: StoryEpisode): StoryCategory => {
  const key = String(story.chapterKey || "").toLocaleLowerCase();
  if (key.includes("linkstory")) return "link";
  if (key.includes("asset_home")) return "home";
  if (key.includes("afterlive")) return "afterlive";
  if (key.includes("tutorial")) return "tutorial";
  return "band";
};

const cards = computed(() =>
  recordValues(cardRecord.value)
    .filter((card) => card.characterId === characterId.value)
    .sort((left, right) => left.cardId - right.cardId),
);
const supports = computed(() =>
  recordValues(supportRecord.value)
    .filter((support) => support.characterIds?.includes(characterId.value) || support.characterId === characterId.value)
    .sort((left, right) => left.supportCardId - right.supportCardId),
);
const stamps = computed(() =>
  recordValues(stampRecord.value)
    .filter((stamp) => stamp.characterIds?.includes(characterId.value))
    .sort((left, right) => left.stampId - right.stampId),
);
const models = computed(() =>
  recordValues(live2dRecord.value)
    .filter((model) => model.characterId === characterId.value)
    .sort((left, right) => left.live2dKey.localeCompare(right.live2dKey, undefined, { numeric: true })),
);
const stories = computed(() =>
  recordValues(storyCatalog.value.episodes)
    .filter((story) => story.characterIds?.includes(characterId.value))
    .sort(
      (left, right) =>
        storyOrder(left) - storyOrder(right) ||
        left.storyKey.localeCompare(right.storyKey, undefined, { numeric: true }),
    ),
);
const songs = computed(() => {
  const selectedBandId = bandId.value;
  if (!selectedBandId) return [];
  return recordValues(songRecord.value)
    .filter((song) => (song.bandIds?.length ? song.bandIds : [song.bandId]).includes(selectedBandId))
    .sort((left, right) => left.musicId - right.musicId);
});
const voiceEntries = computed(() => {
  const entries = Object.entries(voiceRecord.value).map(([key, entry]) => ({
    ...entry,
    voiceKey: entry.voiceKey || key,
  }));
  return entries
    .filter((entry) => entry.characterIds?.includes(characterId.value))
    .sort((left, right) => left.voiceKey.localeCompare(right.voiceKey, undefined, { numeric: true }));
});
const voiceGroups = computed<CharacterVoiceGroup[]>(() =>
  voiceEntries.value.map((entry) => {
    const sources = entry.lines?.length
      ? entry.lines
      : [{ characterId: entry.characterIds?.[0], text: entry.text, sound: entry.sound }];
    const cues = sources
      .map((line) => line.sound?.cueName)
      .filter((cue): cue is string => Boolean(cue));
    const category = cues.length ? cues.join(" / ") : entry.voiceKey || "";
    return {
      key: entry.voiceKey || "",
      category,
      lines: sources.map((line, index) => ({
        key: `${entry.voiceKey}:${index}`,
        characterId: Number(line.characterId || entry.characterIds?.[0] || 0),
        text: resolveLocalized(line.text, { sourceHint: "ja" }) || "",
        cue: line.sound?.cueName || (index === 0 ? entry.sound?.cueName : "") || "",
        playableUrl: line.sound?.playableUrl || (index === 0 ? entry.sound?.playableUrl : "") || "",
      })),
    };
  }),
);
const missions = computed(() => (Array.isArray(missionDocument.value?.missions) ? missionDocument.value.missions : []));
const friendships = computed<CharacterFriendship[]>(() => {
  const entries = Object.entries(friendshipRecord.value).map(([key, entry]) => ({ ...entry, friendshipKey: key }));
  return entries
    .filter((entry) => entry.characterIds?.includes(characterId.value))
    .sort(
      (left, right) =>
        Number(left.friendshipId || left.friendshipKey) - Number(right.friendshipId || right.friendshipKey),
    );
});
function storyOrder(story: StoryEpisode) {
  const categoryOrder = storyCategories.indexOf(storyCategoryOf(story));
  const chapterOrder = /^\d+$/.test(story.chapterKey || "") ? Number(story.chapterKey) : 0;
  return categoryOrder * 1_000_000_000 + chapterOrder * 100_000 + Number(story.storySort || 0);
}

const localizationStrings = (value?: LocalizedValue) => {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((entry): entry is string => Boolean(entry));
  return Object.values(value || {}).filter((entry): entry is string => Boolean(entry));
};

const storyCharacters = (story: StoryEpisode, category: StoryCategory) => {
  if (category !== "link" && category !== "afterlive") return charactersOf(story.characterIds);

  const sourceCharacters = (story.characterIds || [])
    .map((id) => characterMap.value.get(Number(id)))
    .filter((character): character is Character => Boolean(character));
  const titleSources = [...localizationStrings(story.title), story.storyKey].map((value) => value.toLocaleLowerCase());
  const titlePosition = (character: Character) => {
    const aliases = [...localizationStrings(character.nickname), ...localizationStrings(character.characterName)].map(
      (value) => value.toLocaleLowerCase(),
    );
    let position = Number.POSITIVE_INFINITY;
    for (const title of titleSources) {
      for (const alias of aliases) {
        const index = title.indexOf(alias);
        if (index >= 0) position = Math.min(position, index);
      }
    }
    return position;
  };

  return sourceCharacters
    .map((character, sourceIndex) => ({ character, sourceIndex, titlePosition: titlePosition(character) }))
    .sort((left, right) => left.titlePosition - right.titlePosition || left.sourceIndex - right.sourceIndex)
    .map(({ character }) => character);
};

const birthday = computed(() => {
  const value = props.character?.birthday as { month?: number; day?: number } | undefined;
  return value?.month && value?.day ? `${value.month}.${String(value.day).padStart(2, "0")}` : "";
});

const memberTitleOf = (card: MemberCard) =>
  resolveLocalized(card.prefix, { candidates: [textOf(props.title)], sourceHint: "ja" }) || props.title;
const supportTitleOf = (support: SupportCard) =>
  resolveLocalized(support.prefix, {
    candidates: [support.cardName, textOf(props.title)],
    sourceHint: "ja",
  }) || props.title;
const stampTitleOf = (stamp: Stamp) => resolveLocalized(stamp.name, { sourceHint: "ja" }) || t("stamps");
const modelTitleOf = (model: Live2DModel) =>
  resolveLocalized(model.title, {
    candidates: [model.label],
    sourceHint: "ja",
  }) ||
  resolveLocalized(model.live2dName, { sourceHint: "en" }) ||
  model.live2dKey;
const songTitleOf = (song: Song) => resolveSongTitle(song.musicTitle, { sourceHint: "ja" }) || t("songs");
const songBandOf = (song: Song) =>
  resolveLocalized(song.artistName, {
    candidates: [bandMap.value.get(song.bandId || 0)?.bandName],
    sourceHint: "ja",
    fallback: textOf(bandName.value),
  }) || "";
const bondPartners = computed<Character[]>(() => {
  const partnerIds = new Set<number>();
  for (const entry of friendships.value) {
    for (const id of (entry.characterIds || []).map(Number)) {
      if (id && id !== characterId.value) partnerIds.add(id);
    }
  }
  return [...partnerIds]
    .map((id) => characterMap.value.get(id))
    .filter((character): character is Character => Boolean(character))
    .sort((left, right) => left.characterId - right.characterId);
});
// Friendship pairs are strictly within-band, so the partners derived from the
// data never span more than one band and the board's band switcher can't appear.
// To behave like the link-story page (羁绊剧情), surface every other character as
// a candidate — StoryLinkSelector groups them into band tabs — and let rewards
// and stories render (or stay empty) per selected pair.
const friendshipPartnerPool = computed<Character[]>(() =>
  archiveCharacters.value.filter((candidate) => candidate.characterId !== characterId.value),
);
const selectedPartnerId = ref<number | undefined>(undefined);
watch(characterId, () => {
  selectedPartnerId.value = undefined;
});
const selectedFriendship = computed(() =>
  friendships.value.find((entry) => {
    const ids = (entry.characterIds || []).map(Number);
    return Boolean(selectedPartnerId.value) && ids.includes(characterId.value) && ids.includes(selectedPartnerId.value!);
  }),
);
const friendshipRewards = computed<ResourceReferenceItem[]>(() => {
  const entry = selectedFriendship.value;
  if (!entry?.rewards) return [];
  return entry.rewards.map((reward, index) => {
    const resolved = reward.reward?.resolved;
    const fallbackLabel =
      resolveLocalized(reward.reward?.resourceTypeName, { sourceHint: "en" }) || resolved?.kind || t("rewards");
    return {
      key: String(reward.reward?.rewardId || `${entry.friendshipId}:${reward.rank}:${index}`),
      title: resolveLocalized(resolved?.name, { sourceHint: "ja" }) || fallbackLabel,
      subtitle: reward.rank ? `${t("friendshipLevel")} ${reward.rank}` : "",
      image: resolved?.image,
      quantity: `×${Math.max(0, Number(reward.reward?.resourceCount || 0))}`,
    };
  });
});
// Reuse the story tab's link-stories grid verbatim: take the link group already
// built for the story tab and keep only the episodes involving the selected
// partner, so the friendship tab shares the same items, titles and styling
// instead of a bespoke list.
const friendshipStories = computed<StoryCatalogListItem[]>(() => {
  const partnerId = selectedPartnerId.value;
  if (!partnerId) return [];
  const linkItems = storyGroups.value.find((group) => group.id === "link")?.items || [];
  return linkItems.filter((item) => item.avatars?.some((avatar) => avatar.id === partnerId));
});
const friendshipNameOf = (character: Character): DisplayText =>
  resolveLocalized(character.characterName, {
    candidates: [character.englishName],
    sourceHint: "ja",
    fallback: String(character.characterId),
  }) || String(character.characterId);
const friendshipBandNameOf = (bandId: number): DisplayText =>
  resolveLocalized(bandMap.value.get(bandId)?.bandName, { sourceHint: "ja", fallback: String(bandId) }) ||
  String(bandId);
const storyGroups = computed<CharacterStoryGroup[]>(() => {
  const labels: Record<StoryCategory, string> = {
    band: t("bandStories"),
    link: t("linkStories"),
    home: t("home"),
    afterlive: t("afterlive"),
    tutorial: t("tutorial"),
  };
  return storyCategories
    .map((category) => {
      const entries = stories.value.filter((story) => storyCategoryOf(story) === category);
      return {
        id: category,
        label: labels[category],
        media: category === "afterlive" ? ("avatars" as const) : ("thumbnail" as const),
        items: entries.map((story) => {
          const relatedCharacters = storyCharacters(story, category);
          const homeSpot = category === "home" ? homeSpotOfStory(story) : undefined;
          const homeBand = bandMap.value.get(Number(homeSpot?.bandId) || 0);
          const chapter =
            storyCatalog.value.chapters[String(story.chapterId || "")] ||
            Object.values(storyCatalog.value.chapters).find((entry) =>
              entry.episodes.includes(story.storyId || story.storyKey),
            );
          const storyBand = bandMap.value.get(Number(story.bandId || chapter?.bandId) || 0);
          const friendshipLevel = Number(story.unlockCharacterFriendshipLevel) || 0;
          return {
            id: String(story.storyId || story.storyKey),
            title: resolveLocalized(story.title, { sourceHint: "ja" }) || t("story"),
            subtitle:
              category === "band" || category === "tutorial"
                ? resolveLocalized(story.chapterName, {
                    candidates: [chapter?.chapterName],
                    sourceHint: "ja",
                  }) || ""
                : "",
            to: layerLink(storyTo(story), "episode"),
            thumbnail:
              category === "home"
                ? homeSpot?.spine?.backgroundPreview
                : category === "afterlive"
                  ? undefined
                  : story.banner || story.image,
            overlayImage: category === "home" ? homeBand?.logo || homeBand?.icon : storyBand?.logo || storyBand?.icon,
            level: category === "afterlive" ? friendshipLevel : undefined,
            avatars:
              category === "link" || category === "home" || category === "afterlive"
                ? relatedCharacters.map((character) => ({
                    id: character.characterId,
                    name: resolveCharacterName(character, String(character.characterId)),
                    image: character.faceImage || character.thumbnailImage || character.profileImage,
                    color: character.colorCode,
                  }))
                : undefined,
            duration: durationOf(story),
            release: category === "home" || category === "band" ? "" : releaseOf(story),
          };
        }),
      };
    })
    .filter((group) => group.items.length);
});

const characterSectionIds = [
  "profile",
  "cards",
  "stamps",
  "voices",
  "story",
  "friendships",
  "missions",
  "live2d",
  "songs",
] as const;
const activeSection = useRouteQueryEnum("section", characterSectionIds, "profile");
const sections = computed<DetailPeerItem[]>(() => [
  { id: "profile", label: t("profile"), icon: "contact_page" },
  {
    id: "cards",
    label: t("cards"),
    icon: "photo_library",
    count: cards.value.length + supports.value.length,
  },
  { id: "stamps", label: t("stamps"), icon: "sticky_note_2", count: stamps.value.length },
  { id: "voices", label: t("voices"), icon: "mic", count: voiceEntries.value.length },
  { id: "story", label: t("story"), icon: "chat", count: stories.value.length },
  { id: "friendships", label: t("friendships"), icon: "handshake", count: bondPartners.value.length },
  { id: "missions", label: t("characterMissions"), icon: "checklist", count: missions.value.length },
  { id: "live2d", label: t("live2d"), icon: "accessibility_new", count: models.value.length },
  { id: "songs", label: t("songs"), icon: "music_note", count: songs.value.length },
]);
const sectionId = useId();
const sectionPanelId = `${sectionId}-panel`;
const activeSectionTabId = computed(() => `${sectionId}-${activeSection.value}`);

const resolveProfileText = (value: unknown) => resolveLocalized(value as LocalizedValue, { sourceHint: "ja" });
const bandPart = computed(() => resolveProfileText(props.character?.bandPart));
const voiceActor = computed(() => resolveProfileText(props.character?.voiceActor));
const catchCopy = computed(() => resolveProfileText(props.character?.catchCopy));
const description = computed(() => resolveProfileText(props.character?.description));
const bandName = computed(() => resolveLocalized(props.band?.bandName, { sourceHint: "ja" }));
const profileFacts = computed(() =>
  [
    {
      label: t("band"),
      value: bandName.value,
      image: props.band?.logo || props.band?.icon,
      imageAlt: bandName.value || "",
    },
    { label: t("birthday"), value: birthday.value },
    { label: t("height"), value: resolveProfileText(props.character?.height) },
    { label: t("school"), value: resolveProfileText(props.character?.school) },
    { label: t("class"), value: resolveProfileText(props.character?.schoolClass) },
    { label: t("sign"), value: resolveProfileText(props.character?.constellation) },
    { label: t("food"), value: resolveProfileText(props.character?.favoriteFood) },
    { label: t("hobby"), value: resolveProfileText(props.character?.hobby) },
  ].filter((fact) => textOf(fact.value)),
);

const memberCardKey = (card: MemberCard) => card.cardId;
const supportCardKey = (support: SupportCard) => support.supportCardId;
const stampKey = (stamp: Stamp) => stamp.stampId;
const modelKey = (model: Live2DModel) => model.live2dKey;
const songKey = (song: Song) => song.musicId;
const openItem = (to: string, layerKey: string) => void navigateTo(layerLink(to, layerKey));

const activeVoiceUrl = ref("");
const activeVoiceGroupKey = ref("");
const voicePlaying = ref(false);
let voiceAudio: HTMLAudioElement | null = null;
let voiceSequence: VoiceDialogueLine[] = [];
let voiceSequenceIndex = -1;

const voiceDialogueGroups = computed<VoiceDialogueGroup[]>(() =>
  voiceGroups.value.map((group) => ({
    key: group.key,
    label: group.category,
    playing: activeVoiceGroupKey.value === group.key && voicePlaying.value,
    lines: group.lines.map((line) => {
      const character = characterMap.value.get(line.characterId);
      return {
        key: line.key,
        characterId: line.characterId,
        characterName: resolveCharacterName(character, ""),
        characterImage: character?.faceImage || character?.thumbnailImage || character?.profileImage,
        text: line.text,
        cue: line.cue,
        playableUrl: line.playableUrl,
        playing: Boolean(line.playableUrl && activeVoiceUrl.value === line.playableUrl && voicePlaying.value),
      };
    }),
  })),
);

const bindVoiceAudio = () => {
  if (!import.meta.client) return null;
  if (voiceAudio) return voiceAudio;
  voiceAudio = new Audio();
  voiceAudio.preload = "metadata";
  voiceAudio.addEventListener("play", () => {
    voicePlaying.value = true;
  });
  voiceAudio.addEventListener("pause", () => {
    voicePlaying.value = false;
  });
  voiceAudio.addEventListener("ended", () => {
    voicePlaying.value = false;
    void advanceVoiceSequence();
  });
  voiceAudio.addEventListener("error", () => {
    voicePlaying.value = false;
  });
  return voiceAudio;
};

const stopVoicePreview = (clear = false) => {
  voiceAudio?.pause();
  voicePlaying.value = false;
  if (!clear) return;
  if (voiceAudio) {
    voiceAudio.removeAttribute("src");
    voiceAudio.load();
  }
  activeVoiceUrl.value = "";
  activeVoiceGroupKey.value = "";
  voiceSequence = [];
  voiceSequenceIndex = -1;
};

async function playVoiceAt(index: number) {
  const line = voiceSequence[index];
  if (!line?.playableUrl) return;
  const element = bindVoiceAudio();
  if (!element) return;
  voiceSequenceIndex = index;
  if (activeVoiceUrl.value !== line.playableUrl) {
    activeVoiceUrl.value = line.playableUrl;
    element.src = line.playableUrl;
    element.load();
  }
  pauseMusic();
  try {
    await element.play();
  } catch {
    voicePlaying.value = false;
  }
}

async function advanceVoiceSequence() {
  const nextIndex = voiceSequenceIndex + 1;
  if (nextIndex < voiceSequence.length) {
    await playVoiceAt(nextIndex);
    return;
  }
  activeVoiceUrl.value = "";
  activeVoiceGroupKey.value = "";
  voiceSequence = [];
  voiceSequenceIndex = -1;
}

const playVoiceGroup = async (group: VoiceDialogueGroup) => {
  const playableLines = group.lines.filter((line): line is VoiceDialogueLine & { playableUrl: string } =>
    Boolean(line.playableUrl),
  );
  if (!playableLines.length) return;
  const element = bindVoiceAudio();
  if (!element) return;
  if (activeVoiceGroupKey.value === group.key) {
    if (voicePlaying.value) {
      element.pause();
      return;
    }
    pauseMusic();
    try {
      await element.play();
    } catch {
      voicePlaying.value = false;
    }
    return;
  }

  voiceSequence = playableLines;
  voiceSequenceIndex = -1;
  activeVoiceGroupKey.value = group.key;
  await playVoiceAt(0);
};

watch(musicPlaying, (isPlaying) => {
  if (isPlaying) stopVoicePreview(true);
});
watch(activeSection, (section) => {
  if (section !== "voices") stopVoicePreview(true);
});
watch(characterId, () => stopVoicePreview(true));
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) stopVoicePreview(true);
  },
);
onBeforeUnmount(() => stopVoicePreview(true));
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="title"
    :subtitle="bandName || ''"
    :accent="character?.colorCode || 'var(--md-sys-color-primary)'"
    :leading-icons="headerIcons"
    @close="emit('close')"
  >
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="emit('retry')" />
    <div
      v-else-if="character"
      class="character-detail"
      :style="{ '--md-comp-detail-accent': character.colorCode || 'var(--md-sys-color-primary)' }"
    >
      <section class="character-detail__visual" :aria-label="t('visual')">
        <img
          v-if="character.spriteImage"
          class="character-detail__figure"
          :src="character.spriteImage"
          :alt="textOf(title)"
          :lang="langOf(title)"
          decoding="async"
        />
        <img
          v-if="band?.logo"
          class="character-detail__logo"
          :src="band.logo"
          :alt="textOf(bandName)"
          :lang="langOf(bandName)"
        />
      </section>

      <section class="character-detail__archive">
        <DetailPeerTabs
          v-model="activeSection"
          :items="sections"
          :label="t('section')"
          :controls-id="sectionPanelId"
          :id-prefix="sectionId"
        />

        <div
          :id="sectionPanelId"
          class="character-detail__section"
          role="tabpanel"
          :aria-labelledby="activeSectionTabId"
        >
          <div v-if="activeSection === 'profile'" class="character-detail__profile">
            <header class="character-detail__identity">
              <p v-if="subtitle || bandPart" class="character-detail__english display-number">
                <span v-if="bandPart"><DisplayText :value="bandPart" /></span>
                <span v-if="subtitle"><DisplayText :value="subtitle" /></span>
              </p>
              <h3><DisplayText :value="title" /></h3>
              <p v-if="voiceActor" class="character-detail__voice">
                <DisplayText :value="voiceActor" />
              </p>
            </header>

            <blockquote v-if="catchCopy">
              <DisplayText :value="catchCopy" />
            </blockquote>
            <p v-if="description" class="character-detail__description">
              <DisplayText :value="description" />
            </p>
            <dl v-if="profileFacts.length" class="character-detail__facts">
              <div v-for="fact in profileFacts" :key="fact.label" class="character-detail__fact">
                <dt>{{ fact.label }}</dt>
                <dd>
                  <img
                    v-if="fact.image"
                    :src="fact.image"
                    :alt="textOf(fact.imageAlt)"
                    :lang="langOf(fact.imageAlt)"
                    loading="lazy"
                    decoding="async"
                  />
                  <DisplayText :value="fact.value" />
                </dd>
              </div>
            </dl>
          </div>

          <DetailSection
            v-else-if="activeSection === 'cards'"
            class="character-detail__deferred-section"
            :title="t('cards')"
            icon="photo_library"
            :count="cards.length + supports.length"
          >
            <div class="character-detail__groups">
              <DetailSection v-if="cards.length" :title="t('memberCards')" :count="cards.length">
                <CatalogCollectionGrid
                  :items="cards"
                  :item-key="memberCardKey"
                  :label="t('memberCards')"
                  :minimum-column-width="132"
                  :compact-minimum-column-width="108"
                  :media-height-ratio="294 / 224"
                  flow
                >
                  <template #item="{ item: card }">
                    <CatalogCardTile
                      :title="memberTitleOf(card)"
                      character=""
                      :image="card.images?.thumbnail"
                      fallback-aspect-ratio="224 / 294"
                      :attribute="card.cardType"
                      :rarity="card.rarity"
                      @select="openItem(`/catalog/member-cards?card=${card.cardId}`, 'card')"
                    />
                  </template>
                </CatalogCollectionGrid>
              </DetailSection>
              <DetailSection v-if="supports.length" :title="t('supportCards')" :count="supports.length">
                <CatalogCollectionGrid
                  :items="supports"
                  :item-key="supportCardKey"
                  :label="t('supportCards')"
                  :minimum-column-width="180"
                  :compact-minimum-column-width="156"
                  :media-height-ratio="184 / 326"
                  flow
                >
                  <template #item="{ item: support }">
                    <CatalogCardTile
                      :title="supportTitleOf(support)"
                      character=""
                      :image="support.images?.thumbnail"
                      fallback-aspect-ratio="326 / 184"
                      :attribute="support.cardType"
                      :rarity="support.rarity"
                      @select="openItem(`/catalog/support-cards?snap=${support.supportCardId}`, 'snap')"
                    />
                  </template>
                </CatalogCollectionGrid>
              </DetailSection>
              <EmptyState v-if="!cards.length && !supports.length" />
            </div>
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'stamps'"
            class="character-detail__deferred-section"
            :title="t('stamps')"
            icon="sticky_note_2"
            :count="stamps.length"
          >
            <CatalogCollectionGrid
              v-if="stamps.length"
              :items="stamps"
              :item-key="stampKey"
              :label="t('stamps')"
              :minimum-column-width="138"
              :compact-minimum-column-width="108"
              :compact-breakpoint="760"
              :media-height-ratio="4 / 5"
              flow
            >
              <template #item="{ item: stamp }">
                <CollectionTileSurface
                  :label="stampTitleOf(stamp)"
                  :to="layerLink(`/catalog/stamps?stamp=${stamp.stampId}`, 'stamp')"
                >
                  <template #media>
                    <TextFallbackMedia
                      :image="stamp.image"
                      :label="stampTitleOf(stamp)"
                      icon="sticky_note_2"
                      fallback-aspect-ratio="5 / 4"
                    />
                  </template>
                </CollectionTileSurface>
              </template>
            </CatalogCollectionGrid>
            <EmptyState v-else />
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'story'"
            class="character-detail__deferred-section"
            :title="t('story')"
            icon="chat"
            :count="stories.length"
          >
            <div class="character-detail__groups">
              <DetailSection
                v-for="group in storyGroups"
                :key="group.id"
                :title="group.label"
                :count="group.items.length"
              >
                <StoryCatalogList :items="group.items" :media="group.media" layout="grid" :show-cast="false" flow />
              </DetailSection>
              <EmptyState v-if="!storyGroups.length" />
            </div>
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'voices'"
            class="character-detail__deferred-section"
            :title="t('voices')"
            icon="mic"
            :count="voiceEntries.length"
          >
            <LoadingState v-if="voicePending" />
            <ErrorState v-else-if="voiceError" @retry="refreshVoices()" />
            <VoiceDialogueLines
              v-else-if="voiceDialogueGroups.length"
              :groups="voiceDialogueGroups"
              @play="playVoiceGroup"
            />
            <EmptyState v-else />
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'friendships'"
            class="character-detail__deferred-section"
            :title="t('friendships')"
            icon="handshake"
            :count="bondPartners.length"
          >
            <LoadingState v-if="friendshipPending" />
            <ErrorState v-else-if="friendshipError" @retry="refreshFriendships()" />
            <section v-else-if="character && bondPartners.length" class="character-detail__friendships">
              <div class="character-detail__friendship-selector">
                <StoryLinkSelector
                  :characters="[character]"
                  :partners="friendshipPartnerPool"
                  :first-id="characterId"
                  :second-id="selectedPartnerId"
                  :name-of="friendshipNameOf"
                  :band-name-of="friendshipBandNameOf"
                  @second="selectedPartnerId = Number($event) || undefined"
                />
              </div>
              <div v-if="selectedPartnerId" class="character-detail__friendship-detail">
                <DetailSection
                  v-if="friendshipStories.length"
                  :title="t('story')"
                  :count="friendshipStories.length"
                >
                  <StoryCatalogList :items="friendshipStories" media="thumbnail" layout="grid" :show-cast="false" flow />
                </DetailSection>
                <DetailSection v-if="friendshipRewards.length" :title="t('rewards')" :count="friendshipRewards.length">
                  <ResourceReferenceList :items="friendshipRewards" />
                </DetailSection>
                <EmptyState v-if="!friendshipStories.length && !friendshipRewards.length" />
              </div>
            </section>
            <EmptyState v-else />
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'missions'"
            class="character-detail__deferred-section"
            :title="t('characterMissions')"
            icon="checklist"
            :count="missions.length"
          >
            <LoadingState v-if="missionPending" />
            <ErrorState v-else-if="missionError" @retry="refreshMissions()" />
            <CharacterMissionList
              v-else-if="missions.length && character"
              :missions="missions"
              :character="character"
              :origin="origin"
            />
            <EmptyState v-else />
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'live2d'"
            class="character-detail__deferred-section"
            :title="t('live2d')"
            icon="accessibility_new"
            :count="models.length"
          >
            <CatalogCollectionGrid
              v-if="models.length"
              :items="models"
              :item-key="modelKey"
              :label="t('live2d')"
              :minimum-column-width="132"
              :compact-minimum-column-width="108"
              flow
            >
              <template #item="{ item: model }">
                <CollectionTileSurface
                  :label="modelTitleOf(model)"
                  :to="layerLink(`/catalog/live2d?model=${encodeURIComponent(model.live2dKey)}`, 'model')"
                >
                  <template #media>
                    <TextFallbackMedia
                      :image="
                        model.faceImage ||
                        model.thumbnailImage ||
                        character?.faceImage ||
                        character?.thumbnailImage ||
                        character?.profileImage
                      "
                      :label="title"
                      :secondary-label="modelTitleOf(model)"
                      icon="accessibility_new"
                    />
                  </template>
                </CollectionTileSurface>
              </template>
            </CatalogCollectionGrid>
            <EmptyState v-else />
          </DetailSection>

          <DetailSection
            v-else-if="activeSection === 'songs'"
            class="character-detail__deferred-section"
            :title="t('songs')"
            icon="music_note"
            :count="songs.length"
          >
            <CatalogCollectionGrid
              v-if="songs.length"
              :items="songs"
              :item-key="songKey"
              :label="t('songs')"
              :minimum-column-width="126"
              :compact-minimum-column-width="108"
              :estimate-row-height="(width) => width + 48"
              flow
            >
              <template #item="{ item: song }">
                <SongCatalogTile
                  :song="song"
                  :title="songTitleOf(song)"
                  :band="songBandOf(song)"
                  :image="song.jacketThumbUrl || song.jacketUrl"
                  :music-type="song.musicType"
                  :categories="song.musicCategories"
                  :credit-origin="creditOrigin"
                  @select="openItem(`/catalog/songs?song=${song.musicId}`, 'song')"
                />
              </template>
            </CatalogCollectionGrid>
            <EmptyState v-else />
          </DetailSection>
        </div>
      </section>
    </div>
  </FullscreenDetailSurface>
</template>

<style scoped>
.character-detail {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(245px, 0.78fr) minmax(0, 1.52fr);
  overflow: hidden;
  border-radius: 6px;
  background: var(--md-sys-color-surface);
}

.character-detail__visual {
  position: relative;
  min-width: 0;
  min-height: 0;
  isolation: isolate;
  overflow: hidden;
  background:
    repeating-linear-gradient(90deg, transparent 0 71px, rgb(255 255 255 / 0.24) 72px 73px),
    color-mix(in srgb, var(--md-comp-detail-accent) 72%, var(--md-sys-color-surface));
}

.character-detail__visual::after {
  position: absolute;
  z-index: -1;
  inset: auto -10% -26% 22%;
  aspect-ratio: 1;
  border: 1px solid rgb(255 255 255 / 0.36);
  border-radius: 50%;
  content: "";
}

.character-detail__figure {
  position: absolute;
  inset-block: 0;
  left: 50%;
  width: auto;
  max-width: none;
  height: 100%;
  transform: translateX(-50%);
  filter: drop-shadow(0 16px 18px rgb(20 35 68 / 0.15));
  animation: character-figure-in var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized-decelerate);
}

.character-detail__logo {
  position: absolute;
  z-index: 2;
  top: 12px;
  left: 12px;
  width: min(38%, 120px);
  max-height: 42px;
  object-fit: contain;
  object-position: left center;
  filter: drop-shadow(0 2px 7px rgb(255 255 255 / 0.8));
}

.character-detail__archive {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  padding: 0 21px;
  overflow: hidden;
}

.character-detail__section {
  min-width: 0;
  min-height: 0;
  padding: 17px 2px 18px;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.character-detail__profile,
.character-detail__groups {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.character-detail__profile {
  gap: var(--md-sys-spacing-5);
}

.character-detail__groups {
  gap: 22px;
}

.character-detail__identity {
  padding: var(--md-sys-spacing-1) 0 var(--md-sys-spacing-5);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.character-detail__english,
.character-detail__voice,
.character-detail__identity h3,
.character-detail blockquote,
.character-detail__description {
  margin: 0;
}

.character-detail__english {
  display: flex;
  gap: var(--md-sys-spacing-2);
  color: var(--md-comp-detail-accent);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  letter-spacing: 0.04em;
}

.character-detail__identity h3 {
  margin-top: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: clamp(2.25rem, 4.2vw, 3.5rem);
  font-weight: var(--md-sys-typescale-display-small-weight);
  letter-spacing: var(--md-sys-typescale-display-small-tracking);
  line-height: 1.08;
}

.character-detail__voice {
  margin-top: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
}

.character-detail blockquote {
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-body-large-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.character-detail__description {
  max-width: 76ch;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-large-size);
  line-height: 1.85;
  white-space: pre-line;
}

.character-detail__facts {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(96px, 0.3fr) minmax(0, 1fr);
  margin: 0;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.character-detail__fact {
  display: contents;
}

.character-detail__fact dt,
.character-detail__fact dd {
  min-height: 56px;
  align-items: center;
  padding-block: var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.character-detail__fact dt {
  display: flex;
  padding-inline-end: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: var(--md-sys-typescale-body-medium-weight);
}

.character-detail__fact dd {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding-inline-start: var(--md-sys-spacing-2);
  margin: 0;
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-body-large-size);
  font-weight: var(--md-sys-typescale-body-large-weight);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.character-detail__fact dd img {
  width: auto;
  max-width: 88px;
  height: 24px;
  flex: 0 0 auto;
  object-fit: contain;
  object-position: left center;
}

.character-detail__friendships {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-4);
}

/* Reuse the link-story photo board as a fixed-height bond picker. The lead is
   locked to this character, so the left character rail is hidden and the board
   spans full width; the embedded story list is hidden — stories and rewards
   render below in the normal flow. */
.character-detail__friendship-selector {
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
}

.character-detail__friendship-selector :deep(.link-selector) {
  height: auto;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto;
}

.character-detail__friendship-selector :deep(.link-selector__first-rail),
.character-detail__friendship-selector :deep(.link-selector__stories),
.character-detail__friendship-selector :deep(.link-selector__swap) {
  display: none;
}

.character-detail__friendship-selector :deep(.link-selector__stage) {
  grid-column: 1;
  grid-row: 1;
  height: clamp(260px, 44vh, 420px);
}

.character-detail__friendship-detail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--md-sys-spacing-4);
}

@keyframes character-figure-in {
  from {
    opacity: 0.55;
    transform: translate(-50%, 8px);
  }
}

@media (max-width: 900px) {
  .character-detail {
    grid-template-columns: minmax(210px, 0.66fr) minmax(0, 1.34fr);
  }

  .character-detail__archive {
    padding-inline: 14px;
  }
}

@media (max-width: 760px) {
  .character-detail {
    height: auto;
    min-height: 100%;
    grid-template-columns: 1fr;
    grid-template-rows: minmax(280px, 42dvh) auto;
    overflow: visible;
  }

  .character-detail__archive {
    min-height: 0;
    grid-template-rows: auto auto;
    padding-inline: 12px;
    overflow: visible;
  }

  .character-detail__section {
    padding-top: 15px;
    overflow: visible;
  }

  .character-detail__identity h3 {
    font-size: 2.25rem;
  }

  .character-detail__facts {
    grid-template-columns: minmax(84px, 0.34fr) minmax(0, 1fr);
  }

  .character-detail__friendship-selector :deep(.link-selector) {
    grid-template-rows: auto;
  }

  .character-detail__friendship-selector :deep(.link-selector__stage) {
    grid-row: 1;
    height: clamp(220px, 36vh, 320px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .character-detail__figure {
    animation: none;
  }
}
</style>
