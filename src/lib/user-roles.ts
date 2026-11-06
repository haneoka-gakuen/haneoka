// L3 — GEB
// Input: 账户角色与需要检查的角色能力。
// Output: 六级账号身份、游客显示分组及显式能力判定。
// Pos: [Map](L2-2.md)；Worker 与浏览器共用的账户身份契约。
// Effects/Dependencies: 无 I/O；状态、验证、限制和论坛 ACL 仍由调用方判定。

export const MEMBER_TIERS = Object.freeze(["member", "regular", "trusted", "contributor"] as const);
export const STAFF_ROLES = Object.freeze(["moderator", "admin"] as const);
export const USER_ROLES = Object.freeze([...MEMBER_TIERS, ...STAFF_ROLES] as const);
export const USER_GROUPS = Object.freeze(["guest", ...USER_ROLES] as const);

export type UserRole = (typeof USER_ROLES)[number];
export type UserGroup = (typeof USER_GROUPS)[number];
export type MemberTier = (typeof MEMBER_TIERS)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];
export type StoredUserRole = "member" | StaffRole;
export type UserCapability = "community.participate" | "community.moderate" | "site.admin";

export const isUserRole = (value: unknown): value is UserRole => (USER_ROLES as readonly unknown[]).includes(value);
export const isUserGroup = (value: unknown): value is UserGroup => (USER_GROUPS as readonly unknown[]).includes(value);

export const isMemberTier = (value: unknown): value is MemberTier =>
  (MEMBER_TIERS as readonly unknown[]).includes(value);

export const isStaffRole = (value: unknown): value is StaffRole => (STAFF_ROLES as readonly unknown[]).includes(value);

export const effectiveUserRole = (role: StoredUserRole, memberTier?: MemberTier | null): UserRole =>
  isStaffRole(role) ? role : (memberTier ?? "member");

export function hasUserCapability(role: unknown, capability: UserCapability): boolean {
  switch (capability) {
    case "community.participate":
      return isUserRole(role);
    case "community.moderate":
      return isStaffRole(role);
    case "site.admin":
      return role === "admin";
    default:
      return false;
  }
}
