// L3 — GEB
// Input: Scheduled maintenance time and the account tables.
// Output: Removes accounts that never proved a mailbox and hold nothing of their own.
// Pos: [Map](L2.md); account retention beside the database cleanup job.
// Effects/Dependencies: Physically deletes `user` rows; sessions, profiles and pending signup state cascade.

const UNVERIFIED_ACCOUNT_TTL_MS = 3_600_000;
const BATCH = 200;

/**
 * An account stays while its setup link is live, because resending issues a new
 * hour. Third-party sign-ins stay too: a provider can report an unverified email
 * for an account that works. Rows with community activity are left for review.
 */
const EXPIRED_UNVERIFIED_ACCOUNTS = `
  SELECT account.id
  FROM "user" AS account
  WHERE account.emailVerified = 0
    AND (CASE WHEN CAST(account.createdAt AS INTEGER) > 100000000000 THEN CAST(account.createdAt AS INTEGER)
         ELSE CAST(unixepoch(account.createdAt) * 1000 AS INTEGER) END) < ?
    AND NOT EXISTS (SELECT 1 FROM community_identity AS identity WHERE identity.user_id = account.id)
    AND NOT EXISTS (
      SELECT 1 FROM auth_signup_completion AS completion
      WHERE completion.user_id = account.id AND completion.claim_token_expires_at >= ?
    )
    AND NOT EXISTS (SELECT 1 FROM account AS login WHERE login.userId = account.id AND login.providerId <> 'credential')
    AND NOT EXISTS (SELECT 1 FROM community_post AS post WHERE post.author_id = account.id)
    AND NOT EXISTS (SELECT 1 FROM community_comment AS comment WHERE comment.author_id = account.id)
  ORDER BY account.createdAt
  LIMIT ?`;

export async function cleanupUnverifiedAccounts(env: Pick<Env, "DB">, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(EXPIRED_UNVERIFIED_ACCOUNTS)
    .bind(now - UNVERIFIED_ACCOUNT_TTL_MS, now, BATCH)
    .all<{ id: string }>();
  let removed = 0;
  // One at a time: a row some other table still references must not stop the rest.
  for (const { id } of results) {
    try {
      await env.DB.prepare(`DELETE FROM "user" WHERE id = ? AND emailVerified = 0`).bind(id).run();
      removed += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "unverified_account_cleanup_skipped", error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }));
    }
  }
  if (removed) console.log(JSON.stringify({ event: "unverified_accounts_removed", removed }));
  return removed;
}
