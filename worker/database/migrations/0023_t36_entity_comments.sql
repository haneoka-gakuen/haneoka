ALTER TABLE community_comment ADD COLUMN floor_number INTEGER
  CHECK (floor_number IS NULL OR floor_number BETWEEN 1 AND 9007199254740991);

WITH allocated AS (
  SELECT id,ROW_NUMBER() OVER(PARTITION BY post_id ORDER BY created_at,id) AS floor
  FROM community_comment
)
UPDATE community_comment SET floor_number=(SELECT floor FROM allocated WHERE allocated.id=community_comment.id);

CREATE UNIQUE INDEX community_comment_floor_idx ON community_comment(post_id,floor_number);
CREATE TRIGGER community_comment_floor_allocate AFTER INSERT ON community_comment WHEN NEW.floor_number IS NULL BEGIN UPDATE community_comment SET floor_number=( SELECT COALESCE(MAX(floor_number),0)+1 FROM community_comment WHERE post_id=NEW.post_id AND id<>NEW.id ) WHERE id=NEW.id; END;
CREATE TRIGGER community_comment_floor_server_insert BEFORE INSERT ON community_comment WHEN NEW.floor_number IS NOT NULL BEGIN SELECT RAISE(ABORT,'comment floors are server allocated'); END;
CREATE TRIGGER community_comment_floor_immutable BEFORE UPDATE OF floor_number,post_id ON community_comment WHEN (OLD.floor_number IS NOT NULL AND NEW.floor_number IS NOT OLD.floor_number) OR NEW.post_id<>OLD.post_id BEGIN SELECT RAISE(ABORT,'comment floor and thread are immutable'); END;

CREATE TABLE community_entity_thread (
  entity_type TEXT NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 64),
  original_id TEXT NOT NULL CHECK(length(original_id) BETWEEN 1 AND 512),
  post_id TEXT NOT NULL UNIQUE REFERENCES community_post(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  PRIMARY KEY(entity_type,original_id)
);
CREATE TRIGGER community_entity_thread_identity_immutable BEFORE UPDATE ON community_entity_thread BEGIN SELECT RAISE(ABORT,'entity thread identity is immutable'); END;
CREATE TRIGGER community_entity_thread_retained BEFORE DELETE ON community_entity_thread BEGIN SELECT RAISE(ABORT,'entity threads are retained'); END;
CREATE TRIGGER community_entity_thread_no_attachment BEFORE INSERT ON community_post_attachment WHEN EXISTS(SELECT 1 FROM community_entity_thread WHERE post_id=NEW.post_id) BEGIN SELECT RAISE(ABORT,'entity comments cannot attach files'); END;

CREATE TABLE community_forum_purpose (
  purpose TEXT PRIMARY KEY NOT NULL CHECK(length(purpose) BETWEEN 1 AND 64),
  forum_id TEXT NOT NULL REFERENCES community_forum(id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
);
INSERT INTO community_forum_purpose(purpose,forum_id,updated_at)
  SELECT default_purpose,id,updated_at FROM community_forum WHERE default_purpose IS NOT NULL;

CREATE TRIGGER community_forum_purpose_legacy_insert AFTER INSERT ON community_forum WHEN NEW.default_purpose IS NOT NULL BEGIN INSERT INTO community_forum_purpose(purpose,forum_id,updated_at) VALUES(NEW.default_purpose,NEW.id,NEW.updated_at) ON CONFLICT(purpose) DO UPDATE SET forum_id=excluded.forum_id,updated_at=excluded.updated_at; END;
CREATE TRIGGER community_forum_purpose_legacy_update AFTER UPDATE OF default_purpose ON community_forum BEGIN DELETE FROM community_forum_purpose WHERE purpose=OLD.default_purpose AND forum_id=OLD.id; INSERT INTO community_forum_purpose(purpose,forum_id,updated_at) SELECT NEW.default_purpose,NEW.id,NEW.updated_at WHERE NEW.default_purpose IS NOT NULL ON CONFLICT(purpose) DO UPDATE SET forum_id=excluded.forum_id,updated_at=excluded.updated_at; END;

INSERT INTO community_forum(id,slug,group_id,names_json,descriptions_json,icon,sort_order,enabled,
  read_permission,post_permission,reply_permission,manage_permission,default_purpose,version,created_at,updated_at)
VALUES('20000000-0000-4000-8000-000000000014','entity-comments',NULL,
  '{"ja":"詳細コメント","en":"Detail comments","zh-TW":"詳情評論","zh-CN":"详情评论","ko":"상세 댓글"}',
  '{"ja":"各項目についてのコメント。","en":"Comments about catalogue entries.","zh-TW":"討論各項目內容。","zh-CN":"讨论各项目内容。","ko":"각 항목에 대한 이야기입니다."}',
  'comment',140,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum_purpose VALUES('entity-comments','20000000-0000-4000-8000-000000000014',0);
