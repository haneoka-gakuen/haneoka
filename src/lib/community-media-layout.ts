export interface CommunityImage {
  contentUrl: string;
  mediaType?: string;
  displayMediaType?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  posterUrl?: string;
  playbackUrl?: string;
  displayWidth?: number | null;
  displayHeight?: number | null;
  durationSeconds?: number | null;
  fileName?: string;
  width?: number | null;
  height?: number | null;
}
export const communityImageRatio = (image: Partial<CommunityImage>, fallback = 4 / 5) => {
  const width = Number(image.displayWidth || image.width),
    height = Number(image.displayHeight || image.height);
  return width > 0 && height > 0 ? Math.max(0.6, Math.min(1.8, width / height)) : fallback;
};
