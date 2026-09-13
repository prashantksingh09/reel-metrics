// Instagram API client for the Instagram-Login path (graph.instagram.com).
//
// Two behaviours come straight from the Phase 0 probes:
//
// - Error messages are LOCALISED. One probe returned Marathi because that is
//   the account's locale. So nothing here matches on error text; only codes.
//
// - Metrics vanish. Asking for ten in one call means one retired name fails
//   all ten, so a rejected batch falls back to per-metric calls.
//
// Subrequest budget matters: the Workers free plan allows 50 per invocation
// and D1 queries count too. The batch-first design keeps a normal poll near
// ten, with the per-metric fallback only on the rare failing call.
import { IG_HOST, IG_VERSION } from "./config.js";

export class IGError extends Error {
  constructor(message, code, subcode) {
    super(message);
    this.code = code;
    this.subcode = subcode;
  }
}

// Meta documents the token endpoints WITHOUT a version prefix, unlike every
// data endpoint. Matching the docs exactly rather than assuming the versioned
// form also works -- a failed refresh means re-authorising by hand.
const UNVERSIONED = new Set(["access_token", "refresh_access_token"]);

async function apiGet(path, token, params = {}) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const base = UNVERSIONED.has(path)
    ? `https://${IG_HOST}`
    : `https://${IG_HOST}/${IG_VERSION}`;
  const url = `${base}/${path}?${qs}`;
  const res = await fetch(url, { headers: { "User-Agent": "reel-metrics/1.0" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = body.error || {};
    throw new IGError(e.message || `HTTP ${res.status}`, e.code, e.error_subcode);
  }
  return body;
}

// /me has been documented both flat and wrapped in a data array.
function unwrap(payload) {
  if (Array.isArray(payload?.data) && payload.data.length) return payload.data[0];
  return payload;
}

export async function me(token) {
  return unwrap(await apiGet("me", token, {
    fields: "id,user_id,username,name,account_type,media_count,followers_count,follows_count",
  }));
}

export async function recentMedia(token, limit = 25) {
  const body = await apiGet("me/media", token, {
    limit: String(limit),
    fields: "id,media_type,media_product_type,timestamp,permalink,caption",
  });
  return body.data || [];
}

// media_type reads VIDEO for reels and ordinary videos alike. product_type is
// the only field that separates them -- confirmed against a real carousel post
// in the account that would otherwise have been mistaken for one.
export async function reels(token, limit = 25) {
  return (await recentMedia(token, limit))
    .filter((m) => m.media_product_type === "REELS");
}

function flatten(payload) {
  const out = {};
  for (const row of payload?.data || []) {
    const name = row.name;
    let value;
    if (row.total_value !== undefined) value = row.total_value?.value;
    else value = (row.values || []).at(-1)?.value;
    if (name != null && value != null) out[name] = value;
  }
  return out;
}

export async function mediaInsights(token, mediaId, metrics) {
  try {
    return flatten(await apiGet(`${mediaId}/insights`, token,
      { metric: metrics.join(",") }));
  } catch (err) {
    if (!(err instanceof IGError)) throw err;
  }
  // Degrade to one metric at a time so a single dead name cannot blind us to
  // the rest. Costs subrequests, which is why it is the fallback not the path.
  const out = {};
  for (const metric of metrics) {
    try {
      Object.assign(out, flatten(await apiGet(`${mediaId}/insights`, token, { metric })));
    } catch { /* metric unavailable for this media type; skip */ }
  }
  return out;
}

export async function accountInsights(token, igUserId, metrics) {
  const params = { period: "day", metric_type: "total_value" };
  try {
    return flatten(await apiGet(`${igUserId}/insights`, token,
      { ...params, metric: metrics.join(",") }));
  } catch (err) {
    if (!(err instanceof IGError)) throw err;
  }
  const out = {};
  for (const metric of metrics) {
    try {
      Object.assign(out, flatten(await apiGet(`${igUserId}/insights`, token,
        { ...params, metric })));
    } catch { /* skip */ }
  }
  return out;
}

// Refreshable once >=24h old and while still valid. Returns the new token and
// its expiry.
export async function refreshToken(token) {
  const body = await apiGet("refresh_access_token", token,
    { grant_type: "ig_refresh_token" });
  const expires = new Date(Date.now() + (body.expires_in ?? 5184000) * 1000);
  return { token: body.access_token, expiresAt: expires.toISOString() };
}
