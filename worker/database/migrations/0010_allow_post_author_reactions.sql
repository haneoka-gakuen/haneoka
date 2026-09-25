-- Authors may interact with their own posts like any other member: the
-- no-self-like triggers are dropped so a post's author can like it. The
-- notification writer already skips the author, so no self-notification
-- follows from this change.
DROP TRIGGER IF EXISTS community_reaction_no_self_like_before_update;
DROP TRIGGER IF EXISTS community_reaction_no_self_like_before_insert;
