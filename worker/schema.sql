-- D1 is SQLite, so this is nearly identical to the Python version's schema.
--
-- Two shapes worth understanding before changing anything:
--
-- 1. Metrics are stored long (a row per metric per reading), not as columns.
--    Meta retired `plays` and `impressions` in Apr 2025 and added
--    `reels_skip_rate` since; a wide table would need a migration each time.
--
-- 2. Rows are written only when a value CHANGES. Five reels x ten metrics x
--    96 polls a day would otherwise be ~4,800 rows daily, nearly all of them
--    restating that an old reel is still sitting at the same view count. The
--    value at any time T is simply the last row at or before T.

CREATE TABLE IF NOT EXISTS account (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ig_user_id  TEXT NOT NULL UNIQUE,
    username    TEXT,
    added_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id     INTEGER NOT NULL,
    ig_media_id    TEXT NOT NULL UNIQUE,
    product_type   TEXT,
    permalink      TEXT,
    caption        TEXT,
    posted_at      TEXT,
    first_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_snapshot (
    media_id     INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    metric       TEXT NOT NULL,
    value        REAL NOT NULL,
    PRIMARY KEY (media_id, metric, captured_at)
);

CREATE TABLE IF NOT EXISTS account_snapshot (
    account_id   INTEGER NOT NULL,
    captured_at  TEXT NOT NULL,
    metric       TEXT NOT NULL,
    value        REAL NOT NULL,
    PRIMARY KEY (account_id, metric, captured_at)
);

-- Every poll, changed or not. This is how "the reel is quiet" is told apart
-- from "the poller is dead" -- which look identical in the snapshot table.
CREATE TABLE IF NOT EXISTS poll_run (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at   TEXT NOT NULL,
    scope    TEXT NOT NULL,
    ok       INTEGER NOT NULL,
    changed  INTEGER NOT NULL DEFAULT 0,
    note     TEXT
);

-- Secrets are read-only at runtime in Workers, so a refreshed token has to
-- live in the database -- there is nowhere else to put it.
CREATE TABLE IF NOT EXISTS token (
    account_id    INTEGER PRIMARY KEY,
    access_token  TEXT NOT NULL,
    expires_at    TEXT,
    refreshed_at  TEXT
);

-- Small key/value store. Holds first_poll_at so the "how much history do we
-- have" answer survives pruning poll_run.
CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT
);

CREATE INDEX IF NOT EXISTS ix_media_snapshot_lookup
    ON media_snapshot (media_id, metric, captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_media_snapshot_time
    ON media_snapshot (captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_account_snapshot_lookup
    ON account_snapshot (account_id, metric, captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_poll_run_time ON poll_run (ran_at DESC);
CREATE INDEX IF NOT EXISTS ix_media_account ON media (account_id, posted_at DESC);
