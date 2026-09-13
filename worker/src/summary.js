// Builds the payload the widget renders. The widget computes nothing:
// iOS decides when a widget refreshes, so any arithmetic done there would be
// arithmetic done at an unknown time.
import {
  MEDIA_METRICS, ACCOUNT_METRICS, MS_METRICS, RATE_METRICS,
  DELTA_WINDOWS, REELS_TRACKED,
} from "./config.js";
import * as db from "./db.js";

// Meta's media timestamps look like 2026-09-09T16:55:16+0000, which Date
// parses inconsistently across runtimes unless the offset is normalised.
export function parseTs(ts) {
  if (!ts) return null;
  const normalised = ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(normalised);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Baseline value at or before `cutoff`.
 *
 * Subtle, because storage is change-only. Three cases:
 *   - a row inside the window at or before cutoff  -> use it
 *   - no such row, but the newest row overall is older than cutoff -> the
 *     value has not moved since before the cutoff, so the delta is 0
 *   - nothing at all that old -> we were not watching yet, so null, NOT zero
 * That last distinction is the whole reason the widget can say "collecting"
 * instead of confidently displaying a fake +0.
 */
export function baselineAt(rowsAsc, latest, cutoffIso) {
  let best = null;
  for (const r of rowsAsc) {
    if (r.captured_at <= cutoffIso) best = r;
    else break;
  }
  if (best) return Number(best.value);
  if (latest && latest.capturedAt <= cutoffIso) return Number(latest.value);
  return null;
}

export function computeDeltas(rowsAsc, latest, current, now) {
  const out = {};
  for (const [label, hours] of Object.entries(DELTA_WINDOWS)) {
    const cutoff = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    const base = baselineAt(rowsAsc, latest, cutoff);
    // A negative delta is a real result. Two probe runs eleven minutes apart
    // showed a share count fall by two -- people delete shares and Meta
    // revises figures. Clamping that to zero would invent data.
    out[label] = base == null ? null : Math.round((current - base) * 100) / 100;
  }
  return out;
}

export async function build(env) {
  const now = new Date();
  const account = await db.getAccount(env.DB);
  if (!account) {
    return { as_of: now.toISOString(), error: "no account polled yet" };
  }

  const media = await db.getTrackedMedia(env.DB, account.id, REELS_TRACKED);
  const mediaIds = media.map((m) => m.id);

  const since = new Date(now.getTime() - 25 * 3600 * 1000).toISOString();
  const [latest, rows, acctLatest, acctRows, firstPoll, poll, tok] = await Promise.all([
    db.latestValues(env.DB, mediaIds),
    db.windowRows(env.DB, mediaIds, since),
    db.accountLatest(env.DB, account.id),
    db.accountRowsSince(env.DB, account.id,
      new Date(now.getTime() - 8 * 86400 * 1000).toISOString()),
    db.getMeta(env.DB, "first_poll_at"),
    db.lastPoll(env.DB),
    db.getToken(env.DB),
  ]);

  const byMedia = new Map();
  for (const r of rows) {
    const key = `${r.media_id}|${r.metric}`;
    if (!byMedia.has(key)) byMedia.set(key, []);
    byMedia.get(key).push(r);
  }

  const reels = media.map((m) => {
    const metrics = {};
    const deltas = {};
    const mLatest = latest.get(m.id) || new Map();
    for (const metric of MEDIA_METRICS) {
      const last = mLatest.get(metric);
      if (!last) continue;
      const value = Number(last.value);
      metrics[metric] = value;
      if (!RATE_METRICS.includes(metric)) {
        deltas[metric] = computeDeltas(
          byMedia.get(`${m.id}|${metric}`) || [], last, value, now);
      }
    }
    const posted = parseTs(m.posted_at);
    return {
      id: m.ig_media_id,
      permalink: m.permalink,
      caption: (m.caption || "").slice(0, 90),
      posted_at: m.posted_at,
      age_hours: posted ? Math.round((now - posted) / 36000) / 100 : null,
      metrics,
      deltas,
      views_series: (byMedia.get(`${m.id}|views`) || [])
        .map((r) => [r.captured_at, Number(r.value)]),
    };
  });

  const accountMetrics = {};
  for (const metric of [...ACCOUNT_METRICS, "followers_count"]) {
    const last = acctLatest.get(metric);
    if (last) accountMetrics[metric] = Number(last.value);
  }

  let followersDelta = null;
  if (accountMetrics.followers_count != null) {
    const cutoff = new Date(now.getTime() - 7 * 86400 * 1000).toISOString();
    const base = baselineAt(
      acctRows.filter((r) => r.metric === "followers_count"),
      acctLatest.get("followers_count"), cutoff);
    if (base != null) followersDelta = accountMetrics.followers_count - base;
  }

  const historyHours = firstPoll
    ? Math.round((now - new Date(firstPoll)) / 36000) / 100 : 0;

  return {
    as_of: now.toISOString(),
    account: {
      username: account.username,
      metrics: accountMetrics,
      followers_delta_7d: followersDelta,
    },
    latest: reels[0] || null,
    reels,
    units: { ms: MS_METRICS, percent: RATE_METRICS },
    health: {
      history_since: firstPoll,
      history_hours: historyHours,
      last_poll_at: poll?.ran_at ?? null,
      last_poll_ok: poll ? Boolean(poll.ok) : null,
      last_poll_note: poll?.note ?? null,
      token_expires_at: tok?.expires_at ?? null,
      token_days_left: tok?.expires_at
        ? Math.round((new Date(tok.expires_at) - now) / 8640000) / 10 : null,
    },
  };
}
