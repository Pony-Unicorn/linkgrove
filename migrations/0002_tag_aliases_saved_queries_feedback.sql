-- migrations/0002_tag_aliases_saved_queries_feedback.sql
CREATE TABLE
  IF NOT EXISTS tag_aliases (
    id TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tag_id TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai', 'system')),
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_tag_aliases_tag ON tag_aliases (tag_id);

CREATE TABLE
  IF NOT EXISTS saved_queries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    query_json TEXT NOT NULL DEFAULT '{}',
    sort_by TEXT NOT NULL DEFAULT 'created_at',
    sort_dir TEXT NOT NULL DEFAULT 'desc',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS user_feedback_events (
    id TEXT PRIMARY KEY,
    bookmark_id TEXT NOT NULL REFERENCES bookmarks (id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (
      event_type IN (
        'tag_accepted',
        'tag_rejected',
        'tag_added',
        'tag_replaced'
      )
    ),
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_feedback_bookmark ON user_feedback_events (bookmark_id);