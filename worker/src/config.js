// Metrics confirmed working against @your_account's reels on 2026-09-10.
// The poller asks for these and tolerates any of them disappearing; Meta has
// changed this vocabulary twice in eighteen months.
export const MEDIA_METRICS = [
  "views", "reach", "likes", "comments", "shares", "saved",
  "total_interactions", "reels_skip_rate",
  "ig_reels_avg_watch_time", "ig_reels_video_view_total_time",
];

export const ACCOUNT_METRICS = [
  "reach", "views", "profile_views", "accounts_engaged",
  "total_interactions", "likes", "comments", "shares", "saves",
];

// Reported in milliseconds by the API. Declared in the payload so the widget
// never has to carry this knowledge itself.
export const MS_METRICS = ["ig_reels_avg_watch_time", "ig_reels_video_view_total_time"];

// Already a percentage. Must never be delta'd like a counter.
export const RATE_METRICS = ["reels_skip_rate"];

export const IG_HOST = "graph.instagram.com";
export const IG_VERSION = "v26.0";

export const REELS_TRACKED = 5;
export const FRESH_WINDOW_DAYS = 14;

// Refresh the 60-day token with this long left. Generous on purpose: a token
// can only be refreshed while still valid, so lapsing means re-authorising
// by hand and there is no automated way back.
export const TOKEN_REFRESH_AT_DAYS_LEFT = 15;

export const DELTA_WINDOWS = { "1h": 1, "6h": 6, "24h": 24 };

// Keep poll_run bounded. Its only job is recent liveness; first_poll_at lives
// in `meta` so pruning never loses the history-length answer.
export const POLL_RUN_RETENTION_DAYS = 30;
