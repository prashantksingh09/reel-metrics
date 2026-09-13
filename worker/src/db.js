// D1 access, written around one constraint that shapes everything:
//
// On the Workers free plan an invocation gets 50 subrequests, and D1 queries
// count toward that total. The obvious per-metric read/write loop -- ten
// metrics across five reels -- would issue ~100 D1 calls and fail. So reads
// are gathered in single queries and writes go out as one batch().
//
// A normal poll lands around ten subrequests all in.

export async function latestValues(db, mediaIds) {
  // Newest row per (media, metric) in one query, rather than one per metric.
  if (!mediaIds.length) return new Map();
  const holes = mediaIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT s.media_id, s.metric, s.value, s.captured_at
       FROM media_snapshot s
       JOIN (SELECT media_id, metric, MAX(captured_at) AS mx
               FROM media_snapshot
              WHERE media_id IN (${holes})
              GROUP BY media_id, metric) t
         ON t.media_id = s.media_id AND t.metric = s.metric
        AND t.mx = s.captured_at`
  ).bind(...mediaIds).all();

  const map = new Map();
  for (const r of results || []) {
    if (!map.has(r.media_id)) map.set(r.media_id, new Map());
    map.get(r.media_id).set(r.metric, { value: r.value, capturedAt: r.captured_at });
  }
  return map;
}

export async function windowRows(db, mediaIds, sinceIso) {
  // Everything inside the delta window, fetched once and diffed in memory.
  // Change-only storage keeps this small: an old reel contributes almost
  // nothing because almost nothing about it changes.
  if (!mediaIds.length) return [];
  const holes = mediaIds.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT media_id, metric, value, captured_at
       FROM media_snapshot
      WHERE media_id IN (${holes}) AND captured_at >= ?
      ORDER BY captured_at ASC`
  ).bind(...mediaIds, sinceIso).all();
  return results || [];
}

export async function accountLatest(db, accountId) {
  const { results } = await db.prepare(
    `SELECT s.metric, s.value, s.captured_at
       FROM account_snapshot s
       JOIN (SELECT metric, MAX(captured_at) AS mx
               FROM account_snapshot WHERE account_id = ?
              GROUP BY metric) t
         ON t.metric = s.metric AND t.mx = s.captured_at
      WHERE s.account_id = ?`
  ).bind(accountId, accountId).all();
  const map = new Map();
  for (const r of results || []) map.set(r.metric, { value: r.value, capturedAt: r.captured_at });
  return map;
}

export async function accountRowsSince(db, accountId, sinceIso) {
  const { results } = await db.prepare(
    `SELECT metric, value, captured_at FROM account_snapshot
      WHERE account_id = ? AND captured_at >= ? ORDER BY captured_at ASC`
  ).bind(accountId, sinceIso).all();
  return results || [];
}

export async function getMeta(db, key) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}

export async function getAccount(db) {
  return db.prepare("SELECT * FROM account ORDER BY id LIMIT 1").first();
}

export async function getTrackedMedia(db, accountId, limit) {
  const { results } = await db.prepare(
    `SELECT * FROM media WHERE account_id = ? AND product_type = 'REELS'
      ORDER BY posted_at DESC LIMIT ?`
  ).bind(accountId, limit).all();
  return results || [];
}

export async function getToken(db) {
  return db.prepare("SELECT * FROM token ORDER BY account_id LIMIT 1").first();
}

export async function lastPoll(db) {
  return db.prepare("SELECT ran_at, ok, note FROM poll_run ORDER BY ran_at DESC LIMIT 1").first();
}

/** Only values that actually moved become writes. Returns the statements to
 *  batch, so the caller controls how many round trips happen. */
export function changedWrites(db, table, ownerCol, ownerId, latestMap, values, nowIso) {
  const stmts = [];
  for (const [metric, value] of Object.entries(values)) {
    if (value == null) continue;
    const prev = latestMap?.get(metric);
    if (prev != null && Number(prev.value) === Number(value)) continue;
    stmts.push(
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${ownerCol}, captured_at, metric, value)
         VALUES (?, ?, ?, ?)`
      ).bind(ownerId, nowIso, metric, Number(value))
    );
  }
  return stmts;
}
