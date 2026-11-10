CREATE TABLE IF NOT EXISTS community_chart_public_id (
  public_id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (public_id BETWEEN 1 AND 9007199254740991),
  chart_id TEXT NOT NULL UNIQUE REFERENCES community_chart(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS community_chart_public_id_after_insert
AFTER INSERT ON community_chart
BEGIN
  INSERT OR IGNORE INTO community_chart_public_id (chart_id) VALUES (NEW.id);
END;

INSERT INTO community_chart_public_id (chart_id)
SELECT chart.id FROM community_chart AS chart
WHERE NOT EXISTS (SELECT 1 FROM community_chart_public_id AS identity WHERE identity.chart_id = chart.id)
ORDER BY chart.created_at, chart.id;
