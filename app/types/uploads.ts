export const COMMUNITY_ATTACHMENT_MAX_FILES = 10;
export const COMMUNITY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const COMMUNITY_TEXT_MAX_BYTES = 1024 * 1024;

export const COMMUNITY_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type CommunityImageMediaType = (typeof COMMUNITY_IMAGE_MEDIA_TYPES)[number];
export type CommunityAttachmentMediaType = CommunityImageMediaType | "text/plain";
export type CommunityAttachmentStatus = "reserved" | "scanning" | "ready" | "review" | "rejected" | "deleted";
export type CommunityAttachmentModerationStatus = "pending" | "allow" | "review" | "block";

export interface CommunityAttachment {
  id: string;
  fileName: string;
  mediaType: CommunityAttachmentMediaType;
  size: number;
  status: CommunityAttachmentStatus;
  moderationStatus: CommunityAttachmentModerationStatus;
  createdAt: number;
  expiresAt: number;
  uploadUrl: string | null;
  downloadUrl: string | null;
  failureCode: string | null;
}

export interface CommunityAttachmentQueueState {
  busy: boolean;
  count: number;
  errorCount: number;
  ready: boolean;
}

export const isCommunityImageMediaType = (value: string): value is CommunityImageMediaType =>
  COMMUNITY_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value);

export const isCommunityAttachmentMediaType = (value: string): value is CommunityAttachmentMediaType =>
  value === "text/plain" || isCommunityImageMediaType(value);

export const isCommunityAttachmentStatus = (value: string): value is CommunityAttachmentStatus =>
  ["reserved", "scanning", "ready", "review", "rejected", "deleted"].includes(value);

export const isCommunityAttachmentModerationStatus = (value: string): value is CommunityAttachmentModerationStatus =>
  ["pending", "allow", "review", "block"].includes(value);
