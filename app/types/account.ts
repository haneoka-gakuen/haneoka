export type AccountRole = "admin" | "member" | "moderator";
export type AccountProfileStatus = "active" | "deleted" | "suspended";

export interface AccountProfile {
  accountName: string;
  avatarSeed: string;
  avatarUrl: string | null;
  bio: string | null;
  candidateDisplayName: string | null;
  displayName: string | null;
  displayNameRevision: number;
  displayNameStatus: "allow" | "block" | "pending";
  handle: string | null;
  profileStatus: AccountProfileStatus;
  publicUid: number;
  role: AccountRole;
  version: number;
}

export interface AccountProfileResponse {
  profile: AccountProfile;
}
