CREATE TABLE community_forum_group (
 id TEXT PRIMARY KEY NOT NULL,
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 80),
 names_json TEXT NOT NULL CHECK(json_valid(names_json) AND json_type(names_json)='object'),
 sort_order INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
CREATE TABLE community_forum (
 id TEXT PRIMARY KEY NOT NULL,
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 80),
 group_id TEXT REFERENCES community_forum_group(id) ON DELETE RESTRICT,
 names_json TEXT NOT NULL CHECK(json_valid(names_json) AND json_type(names_json)='object'),
 descriptions_json TEXT NOT NULL CHECK(json_valid(descriptions_json) AND json_type(descriptions_json)='object'),
 icon TEXT NOT NULL CHECK(length(icon) BETWEEN 1 AND 80),
 sort_order INTEGER NOT NULL DEFAULT 0,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 read_permission TEXT NOT NULL DEFAULT 'public' CHECK(read_permission IN ('public','member','verified','moderator','admin','none')),
 post_permission TEXT NOT NULL DEFAULT 'verified' CHECK(post_permission IN ('verified','moderator','admin','none')),
 reply_permission TEXT NOT NULL DEFAULT 'verified' CHECK(reply_permission IN ('verified','moderator','admin','none')),
 manage_permission TEXT NOT NULL DEFAULT 'admin' CHECK(manage_permission IN ('moderator','admin')),
 default_purpose TEXT CHECK(default_purpose IS NULL OR default_purpose IN ('general','stamp')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
CREATE TABLE community_forum_slug_alias (
 slug TEXT PRIMARY KEY NOT NULL CHECK(length(slug) BETWEEN 1 AND 80),
 forum_id TEXT NOT NULL REFERENCES community_forum(id) ON DELETE RESTRICT,
 created_at INTEGER NOT NULL
);
CREATE INDEX community_forum_slug_alias_forum_idx ON community_forum_slug_alias(forum_id,slug);
CREATE UNIQUE INDEX community_forum_default_purpose_idx ON community_forum(default_purpose) WHERE default_purpose IS NOT NULL;
CREATE INDEX community_forum_sort_idx ON community_forum(sort_order,id);
CREATE TABLE community_tag_group (
 id TEXT PRIMARY KEY NOT NULL,
 slug TEXT NOT NULL UNIQUE CHECK(length(slug) BETWEEN 1 AND 80),
 names_json TEXT NOT NULL CHECK(json_valid(names_json) AND json_type(names_json)='object'),
 sort_order INTEGER NOT NULL DEFAULT 0,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
INSERT INTO community_forum_group VALUES ('10000000-0000-4000-8000-000000000001','discussion','{"ja":"交流","en":"Discussion","zh-TW":"交流","zh-CN":"交流","ko":"이야기"}',10,1,0,0);
INSERT INTO community_forum_group VALUES ('10000000-0000-4000-8000-000000000002','creative','{"ja":"創作","en":"Creative","zh-TW":"創作","zh-CN":"创作","ko":"창작"}',20,1,0,0);
INSERT INTO community_forum_group VALUES ('10000000-0000-4000-8000-000000000003','support','{"ja":"ヘルプ・攻略","en":"Help & guides","zh-TW":"求助與攻略","zh-CN":"求助与攻略","ko":"도움말과 공략"}',30,1,0,0);
INSERT INTO community_forum_group VALUES ('10000000-0000-4000-8000-000000000004','announcements','{"ja":"お知らせ","en":"Announcements","zh-TW":"公告","zh-CN":"公告","ko":"공지"}',40,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000001','general','10000000-0000-4000-8000-000000000001','{"ja":"総合","en":"General","zh-TW":"綜合討論","zh-CN":"综合讨论","ko":"종합"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','forum',10,1,'public','verified','verified','admin','general',1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000002','off-topic','10000000-0000-4000-8000-000000000001','{"ja":"雑談","en":"Off-topic","zh-TW":"閒聊","zh-CN":"闲聊","ko":"잡담"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','chat',20,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000003','gacha','10000000-0000-4000-8000-000000000001','{"ja":"ガチャ","en":"Gacha","zh-TW":"轉蛋","zh-CN":"扭蛋","ko":"가챠"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','casino',30,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000004','stamp','10000000-0000-4000-8000-000000000002','{"ja":"スタンプ","en":"Stamps","zh-TW":"表情貼圖","zh-CN":"表情贴图","ko":"스탬프"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','sentiment_satisfied',40,1,'public','verified','verified','admin','stamp',1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000005','chart','10000000-0000-4000-8000-000000000002','{"ja":"譜面","en":"Charts","zh-TW":"譜面","zh-CN":"谱面","ko":"채보"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','music_note',50,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000006','story','10000000-0000-4000-8000-000000000002','{"ja":"ストーリー","en":"Stories","zh-TW":"劇情","zh-CN":"剧情","ko":"스토리"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','menu_book',60,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000007','feedback','10000000-0000-4000-8000-000000000003','{"ja":"フィードバック","en":"Feedback","zh-TW":"意見回饋","zh-CN":"意见反馈","ko":"피드백"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','feedback',70,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000008','bug-report','10000000-0000-4000-8000-000000000003','{"ja":"不具合報告","en":"Bug reports","zh-TW":"錯誤回報","zh-CN":"错误报告","ko":"오류 신고"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','bug_report',80,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000009','new-feature-request','10000000-0000-4000-8000-000000000003','{"ja":"機能リクエスト","en":"Feature requests","zh-TW":"功能建議","zh-CN":"功能建议","ko":"기능 요청"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','lightbulb',90,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000010','help','10000000-0000-4000-8000-000000000003','{"ja":"質問・相談","en":"Help","zh-TW":"求助","zh-CN":"求助","ko":"질문"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','help',100,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000011','team-building','10000000-0000-4000-8000-000000000003','{"ja":"編成","en":"Team building","zh-TW":"配隊","zh-CN":"配队","ko":"팀 편성"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','groups',110,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000012','guides','10000000-0000-4000-8000-000000000003','{"ja":"攻略","en":"Guides","zh-TW":"攻略","zh-CN":"攻略","ko":"공략"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','school',120,1,'public','verified','verified','admin',NULL,1,0,0);
INSERT INTO community_forum VALUES ('20000000-0000-4000-8000-000000000013','admin-announcements','10000000-0000-4000-8000-000000000004','{"ja":"運営からのお知らせ","en":"Site announcements","zh-TW":"站務公告","zh-CN":"站务公告","ko":"운영 공지"}','{"ja":"この板の話題を投稿できます。","en":"Discuss this topic here.","zh-TW":"在此討論這個主題。","zh-CN":"在此讨论这个主题。","ko":"이 주제를 이야기하세요."}','campaign',130,1,'public','admin','admin','admin',NULL,1,0,0);
ALTER TABLE community_post ADD COLUMN forum_id TEXT REFERENCES community_forum(id) ON DELETE RESTRICT;
UPDATE community_post SET forum_id=(SELECT id FROM community_forum WHERE default_purpose='general') WHERE forum_id IS NULL;
CREATE INDEX community_post_forum_feed_idx ON community_post(forum_id,status,deleted_at,created_at DESC,id DESC);
ALTER TABLE community_tag ADD COLUMN group_id TEXT REFERENCES community_tag_group(id) ON DELETE RESTRICT;
ALTER TABLE community_tag ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1);
CREATE TABLE community_forum_audit (
 id TEXT PRIMARY KEY NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('forum_create','forum_edit','post_move','forum_group_create','forum_group_edit','tag_group_create','tag_group_edit','tag_create','tag_edit')),
 target_id TEXT NOT NULL,
 post_id TEXT REFERENCES community_post(id) ON DELETE RESTRICT,
 before_json TEXT NOT NULL CHECK(json_valid(before_json) AND json_type(before_json)='object'),
 after_json TEXT NOT NULL CHECK(json_valid(after_json) AND json_type(after_json)='object'),
 reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
 created_at INTEGER NOT NULL
);
CREATE INDEX community_forum_audit_target_idx ON community_forum_audit(target_id,created_at DESC,id DESC);
CREATE TRIGGER community_forum_audit_immutable_update BEFORE UPDATE ON community_forum_audit BEGIN SELECT RAISE(ABORT,'forum audit immutable'); END;
CREATE TRIGGER community_forum_audit_immutable_delete BEFORE DELETE ON community_forum_audit BEGIN SELECT RAISE(ABORT,'forum audit immutable'); END;
CREATE TRIGGER community_post_forum_default_after_insert AFTER INSERT ON community_post WHEN NEW.forum_id IS NULL
BEGIN
 UPDATE community_post SET forum_id=(SELECT id FROM community_forum WHERE default_purpose='general') WHERE id=NEW.id;
 SELECT CASE WHEN (SELECT forum_id FROM community_post WHERE id=NEW.id) IS NULL THEN RAISE(ABORT,'default forum required') END;
END;
CREATE TRIGGER community_post_forum_required_update BEFORE UPDATE OF forum_id ON community_post WHEN NEW.forum_id IS NULL
BEGIN SELECT RAISE(ABORT,'forum required'); END;
