import { poll, maybeRefreshToken, prunePollRuns } from "./poller.js";
import { build } from "./summary.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Constant-time-ish comparison. The key is a bearer secret in a URL; not
// worth being sloppy about even at this scale.
function keyOk(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key")
      || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

    // Unauthenticated on purpose: liveness only, never numbers.
    if (url.pathname === "/health") {
      let row;
      try {
        row = await env.DB.prepare(
          "SELECT ran_at, ok FROM poll_run ORDER BY ran_at DESC LIMIT 1"
        ).first();
      } catch (err) {
        return json({
          ok: false,
          error: "database not initialised",
          hint: "run: wrangler d1 execute reel-metrics --remote --file=schema.sql",
          detail: String(err?.message || err).slice(0, 200),
        }, 503);
      }
      const hasToken = await env.DB.prepare(
        "SELECT 1 AS x FROM token LIMIT 1").first().catch(() => null);

      // Cadence, not just liveness. "When did it last poll" cannot tell a
      // system that runs every 15 minutes apart from one that fires twice a
      // day -- you have to watch it for an hour to find out. These numbers
      // answer it from history instead.
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { results: recent } = await env.DB.prepare(
        "SELECT ran_at, ok FROM poll_run WHERE ran_at >= ? ORDER BY ran_at DESC LIMIT 200"
      ).bind(since).all().catch(() => ({ results: [] }));

      const stamps = (recent || []).map((r) => Date.parse(r.ran_at)).sort((a, b) => a - b);
      let worstGapMin = null;
      for (let i = 1; i < stamps.length; i++) {
        const gap = (stamps[i] - stamps[i - 1]) / 60000;
        if (worstGapMin == null || gap > worstGapMin) worstGapMin = gap;
      }

      return json({
        ok: true,
        schema: "ready",
        // Both false on a fresh deploy, true after the first poll.
        token_stored: Boolean(hasToken),
        polled_yet: Boolean(row),
        last_poll_at: row?.ran_at ?? null,
        last_poll_ok: row ? Boolean(row.ok) : null,
        // A 15-minute cron should produce 96 in a day. Anything far below
        // that means it is firing intermittently, which is invisible from
        // last_poll_at alone.
        polls_24h: (recent || []).length,
        polls_24h_expected: 96,
        polls_failed_24h: (recent || []).filter((r) => !r.ok).length,
        worst_gap_min: worstGapMin == null ? null : Math.round(worstGapMin),
      });
    }

    if (!env.API_KEY) return json({ error: "API_KEY not configured" }, 500);
    if (!keyOk(key, env.API_KEY)) return json({ error: "unauthorised" }, 401);

    if (url.pathname === "/summary") return json(await build(env));

    if (url.pathname === "/poll" && request.method === "POST") {
      const scope = url.searchParams.get("scope") === "fresh" ? "fresh" : "all";
      return json(await poll(env, scope));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime);
    const minute = at.getUTCMinutes();
    const hour = at.getUTCHours();

    // Top of the hour does the full sweep: every tracked reel including ones
    // past the fresh window, plus account-level insights. The other three
    // ticks in the hour only touch recent reels, which is where movement is.
    const scope = minute < 15 ? "all" : "fresh";

    // Logged so `wrangler tail` can tell "the cron never fired" apart from
    // "it fired and the work failed". Those are completely different problems
    // and they look identical from the database, which records nothing either
    // way.
    console.log(`cron fired: ${event.cron || "?"} scope=${scope}`);

    // Awaited, not handed to ctx.waitUntil(). waitUntil returns immediately
    // and reports the invocation complete, which hides failures and leaves
    // the work's survival to the runtime's discretion. A scheduled handler
    // gets 15 minutes of wall time; this job takes seconds. There is no
    // reason not to simply wait for it.
    const res = await poll(env, scope);
    console.log(`poll ${res.ok ? "ok" : "FAILED"} ${JSON.stringify(res)}`);

    // Once a day, well away from the busy top-of-hour tick.
    if (hour === 3 && minute < 15) {
      const t = await maybeRefreshToken(env);
      console.log(`token check: ${t.note}`);
      await prunePollRuns(env);
    }
  },
};
