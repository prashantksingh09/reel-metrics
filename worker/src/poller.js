import * as ig from "./ig.js";
import * as db from "./db.js";
import {
  MEDIA_METRICS, ACCOUNT_METRICS, REELS_TRACKED, FRESH_WINDOW_DAYS,
  TOKEN_REFRESH_AT_DAYS_LEFT, POLL_RUN_RETENTION_DAYS,
} from "./config.js";
import { parseTs } from "./summary.js";

// The stored token wins over the secret: once refreshed, the database holds a
// newer value than the one the Worker was deployed with, and secrets cannot
// be written at runtime.
async function currentToken(env) {
  // Runs before poll()'s try block, so it must not throw. An uninitialised
  // database here means the schema was never applied -- fall back to the
  // secret so the poll proceeds to a real error message rather than an
  // unhandled rejection in a cron with nobody watching.
  let row = null;
  try {
    row = await db.getToken(env.DB);
  } catch { /* no schema yet */ }
  return row?.access_token || env.IG_ACCESS_TOKEN || "";
}

function isFresh(postedAt, now) {
  const posted = parseTs(postedAt);
  if (!posted) return true;
  return (now - posted) <= FRESH_WINDOW_DAYS * 86400 * 1000;
}

export async function poll(env, scope = "fresh") {
  const now = new Date();
  const nowIso = now.toISOString();
  const token = await currentToken(env);

  if (!token) {
    try {
      await env.DB.prepare(
        "INSERT INTO poll_run (ran_at, scope, ok, note) VALUES (?,?,0,?)"
      ).bind(nowIso, scope, "no token configured").run();
    } catch { /* schema may not exist yet; the return value still says so */ }
    return { ok: false, note: "no token configured" };
  }

  try {
    const profile = await ig.me(token);

    await env.DB.prepare(
      `INSERT INTO account (ig_user_id, username, added_at) VALUES (?,?,?)
       ON CONFLICT(ig_user_id) DO UPDATE SET username = excluded.username`
    ).bind(profile.user_id, profile.username ?? null, nowIso).run();
    const account = await db.getAccount(env.DB);

    const existingToken = await db.getToken(env.DB);
    const writes = [];
    // Bookkeeping inserts (token row, first_poll_at) are writes but are not
    // metric changes. Counting them made the first poll claim movement that
    // had not happened.
    let bookkeeping = 0;
    if (!existingToken) {
      const assumed = new Date(now.getTime() + 60 * 86400 * 1000).toISOString();
      writes.push(env.DB.prepare(
        "INSERT INTO token (account_id, access_token, expires_at) VALUES (?,?,?)"
      ).bind(account.id, token, assumed));
      bookkeeping++;
    }

    // first_poll_at underpins the honest "we have N hours of history" answer,
    // and survives pruning poll_run.
    writes.push(env.DB.prepare(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('first_poll_at', ?)"
    ).bind(nowIso));
    bookkeeping++;

    const fetched = (await ig.reels(token)).slice(0, REELS_TRACKED);

    // Register media first so their primary keys exist for the snapshot rows.
    for (const m of fetched) {
      await env.DB.prepare(
        `INSERT INTO media (account_id, ig_media_id, product_type, permalink,
                            caption, posted_at, first_seen_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(ig_media_id) DO UPDATE SET
           permalink = excluded.permalink, caption = excluded.caption`
      ).bind(account.id, m.id, m.media_product_type ?? null, m.permalink ?? null,
             (m.caption || "").slice(0, 500), m.timestamp ?? null, nowIso).run();
    }

    const tracked = await db.getTrackedMedia(env.DB, account.id, REELS_TRACKED);
    const byIgId = new Map(tracked.map((t) => [t.ig_media_id, t]));
    const due = fetched.filter((m) => scope === "all" || isFresh(m.timestamp, now));

    // One read for every media/metric pair, rather than one per pair.
    const latest = await db.latestValues(env.DB, due.map((m) => byIgId.get(m.id)?.id).filter(Boolean));

    for (const m of due) {
      const row = byIgId.get(m.id);
      if (!row) continue;
      const values = await ig.mediaInsights(token, m.id, MEDIA_METRICS);
      writes.push(...db.changedWrites(
        env.DB, "media_snapshot", "media_id", row.id,
        latest.get(row.id), values, nowIso));
    }

    const acctLatest = await db.accountLatest(env.DB, account.id);
    const profileCounts = {};
    for (const f of ["followers_count", "follows_count", "media_count"]) {
      if (profile[f] != null) profileCounts[f] = profile[f];
    }
    writes.push(...db.changedWrites(
      env.DB, "account_snapshot", "account_id", account.id,
      acctLatest, profileCounts, nowIso));

    if (scope === "all") {
      const acct = await ig.accountInsights(token, profile.user_id, ACCOUNT_METRICS);
      writes.push(...db.changedWrites(
        env.DB, "account_snapshot", "account_id", account.id,
        acctLatest, acct, nowIso));
    }

    const changed = writes.length - bookkeeping;
    writes.push(env.DB.prepare(
      "INSERT INTO poll_run (ran_at, scope, ok, changed) VALUES (?,?,1,?)"
    ).bind(nowIso, scope, changed));

    // One round trip for every write in the cycle.
    await env.DB.batch(writes);
    return { ok: true, changed, polled: due.length };

  } catch (err) {
    // Codes, never message text -- Meta localises error strings, so matching
    // on them would work in English and silently fail in Marathi.
    const note = err instanceof ig.IGError
      ? `code=${err.code} subcode=${err.subcode}`
      : `unexpected: ${err?.name || "error"}: ${String(err?.message || "").slice(0, 120)}`;
    try {
      await env.DB.prepare(
        "INSERT INTO poll_run (ran_at, scope, ok, note) VALUES (?,?,0,?)"
      ).bind(nowIso, scope, note).run();
    } catch {
      // Recording the failure failed too, which almost always means the
      // schema was never applied. Say so instead of masking it.
      return { ok: false, note, db: "unwritable -- did schema.sql run with --remote?" };
    }
    return { ok: false, note };
  }
}

export async function maybeRefreshToken(env) {
  const row = await db.getToken(env.DB);
  if (!row) return { ok: false, note: "no token stored yet" };

  const now = new Date();
  if (row.expires_at) {
    const daysLeft = (new Date(row.expires_at) - now) / 86400000;
    if (daysLeft > TOKEN_REFRESH_AT_DAYS_LEFT) {
      return { ok: true, note: `${daysLeft.toFixed(1)} days left, no action` };
    }
  }

  try {
    const { token, expiresAt } = await ig.refreshToken(row.access_token);
    await env.DB.prepare(
      "UPDATE token SET access_token=?, expires_at=?, refreshed_at=? WHERE account_id=?"
    ).bind(token, expiresAt, now.toISOString(), row.account_id).run();
    return { ok: true, note: `refreshed until ${expiresAt}` };
  } catch (err) {
    return { ok: false, note: `refresh failed code=${err?.code}` };
  }
}

export async function prunePollRuns(env) {
  const cutoff = new Date(Date.now() - POLL_RUN_RETENTION_DAYS * 86400000).toISOString();
  await env.DB.prepare("DELETE FROM poll_run WHERE ran_at < ?").bind(cutoff).run();
}
