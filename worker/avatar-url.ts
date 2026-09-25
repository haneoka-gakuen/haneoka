/**
 * Avatar URL derivation for serializers.
 *
 * `"user".image is never populated — the avatar pipeline links
 * community_profile_avatar to a moderated community_attachment row and only
 * clears the column on deletion. Every read that wants an avatar therefore
 * derives it from those tables; the served URL is the avatar route, whose
 * responses revalidate by ETag.
 *
 * `alias` is the joined `"user"` table alias of the person being described.
 * It is interpolated by this module's callers only — never from user input.
 */
export const avatarUrlSelect = (alias: string): string => `
  (SELECT '/api/v1/account/avatar/' || ${alias}.id
   FROM community_profile_avatar AS ${alias}_avatar_link
   JOIN community_attachment AS ${alias}_avatar_file
     ON ${alias}_avatar_file.id = ${alias}_avatar_link.attachment_id
   WHERE ${alias}_avatar_link.user_id = ${alias}.id
     AND ${alias}_avatar_file.purpose = 'avatar'
     AND ${alias}_avatar_file.status = 'ready'
     AND ${alias}_avatar_file.moderation_status = 'allow'
     AND ${alias}_avatar_file.deleted_at IS NULL
   LIMIT 1)`;
