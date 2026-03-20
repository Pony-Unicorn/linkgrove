-- migrations/0001_initial.sql
CREATE TABLE
  IF NOT EXISTS bookmarks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'other' CHECK (
      type IN (
        'article',
        'video',
        'tool',
        'docs',
        'paper',
        'other'
      )
    ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_bookmarks_domain ON bookmarks (domain);

CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks (created_at DESC);

CREATE TABLE
  IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE
  IF NOT EXISTS bookmark_tags (
    bookmark_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai', 'rule')),
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (bookmark_id, tag_id),
    FOREIGN KEY (bookmark_id) REFERENCES bookmarks (id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
  );

CREATE INDEX IF NOT EXISTS idx_bookmark_tags_bookmark ON bookmark_tags (bookmark_id);

CREATE INDEX IF NOT EXISTS idx_bookmark_tags_tag ON bookmark_tags (tag_id);