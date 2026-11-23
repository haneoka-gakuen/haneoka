CREATE TABLE IF NOT EXISTS community_chart_publication (
  chart_id TEXT PRIMARY KEY NOT NULL,
  revision INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
  FOREIGN KEY (chart_id, revision) REFERENCES community_chart_revision(chart_id, revision) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS community_chart_approve_pending_cover
AFTER UPDATE OF status, moderation_status ON community_attachment
WHEN NEW.status = 'ready' AND NEW.moderation_status = 'allow' AND NEW.deleted_at IS NULL
  AND (OLD.status <> 'ready' OR OLD.moderation_status <> 'allow')
BEGIN
  UPDATE community_chart_revision
  SET published_at = NEW.updated_at
  WHERE cover_attachment_id = NEW.id AND published_at IS NULL
    AND EXISTS (
      SELECT 1 FROM community_chart_publication pending
      WHERE pending.chart_id = community_chart_revision.chart_id AND pending.revision = community_chart_revision.revision
    );

  UPDATE community_chart
  SET (published_revision, visibility, updated_at) = (
    SELECT pending.revision, pending.visibility, MAX(community_chart.updated_at, NEW.updated_at)
    FROM community_chart_publication pending
    WHERE pending.chart_id = community_chart.id
  )
  WHERE deleted_at IS NULL AND id IN (
    SELECT revision.chart_id FROM community_chart_revision revision
    JOIN community_chart_publication pending ON pending.chart_id = revision.chart_id AND pending.revision = revision.revision
    WHERE revision.cover_attachment_id = NEW.id
  );

  DELETE FROM community_chart_publication
  WHERE (chart_id, revision) IN (
    SELECT chart_id, revision FROM community_chart_revision WHERE cover_attachment_id = NEW.id
  );
END;

CREATE TRIGGER IF NOT EXISTS community_chart_clear_pending_publication
AFTER UPDATE OF published_revision, deleted_at ON community_chart
WHEN NEW.published_revision IS NULL OR NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM community_chart_publication WHERE chart_id = NEW.id;
END;
