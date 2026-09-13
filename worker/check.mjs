#!/usr/bin/env node
// Status check for the deployed Worker.
//
//   node check.mjs           one-shot: is everything healthy right now?
//   node check.mjs --watch   waits up to 20 min to SEE the cron fire
//
// The one-shot reads how long ago the last poll was and infers from that.
// --watch is the stronger proof: it sits and waits for the timestamp to move
// on its own, which is the only way to be certain nobody triggered it.
//
// Reads the URL and key from .deploy-info, so no secrets on the command line.
import { readFileSync } from "node:fs";

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

let cfg;
try {
  const raw = readFileSync(new URL("./.deploy-info", import.meta.url), "utf8");
  cfg = Object.fromEntries(raw.trim().split("\n").map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)];
  }));
} catch {
  console.error("\n  No .deploy-info here. Run ./deploy.sh first.\n");
  process.exit(1);
}
if (!cfg.URL || !cfg.API_KEY) {
  console.error("\n  .deploy-info is missing URL or API_KEY.\n");
  process.exit(1);
}

const mins = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

async function get(path, auth = false) {
  const url = cfg.URL + path + (auth ? `?key=${encodeURIComponent(cfg.API_KEY)}` : "");
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function watch() {
  console.log(`\n${B("Watching for the cron to fire")}`);
  console.log(DIM("  It runs every 15 minutes. Nothing here triggers it — we just watch."));
  console.log(DIM("  Ctrl-C to stop.\n"));

  const start = await get("/health");
  if (!start.body?.ok) {
    console.log(R("  Worker is not healthy: ") + (start.body?.error || start.status));
    if (start.body?.hint) console.log("  " + start.body.hint);
    process.exit(1);
  }
  let baseline = start.body.last_poll_at;
  console.log(`  baseline: last poll at ${baseline ? clock(baseline) : "never"}`);

  for (let i = 0; i < 21; i++) {
    await new Promise((r) => setTimeout(r, Number(process.env.CHECK_INTERVAL_MS) || 60000));
    const { body } = await get("/health").catch(() => ({ body: null }));
    const now = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (!body) { console.log(`  ${now}  ${Y("unreachable, retrying")}`); continue; }
    if (body.last_poll_at !== baseline) {
      console.log(`  ${now}  last poll ${clock(body.last_poll_at)}  ${G("CRON FIRED")}`);
      console.log(`\n  ${G("Confirmed.")} It is collecting on its own. Nothing else to do.\n`);
      return;
    }
    console.log(`  ${now}  last poll ${baseline ? clock(baseline) : "never"}  ${DIM("(waiting)")}`);
  }
  console.log(`\n  ${R("No poll in 21 minutes.")} The cron is not firing.`);
  console.log("  Check:  wrangler deployments list");
  console.log("  and the Cloudflare dashboard > your Worker > Settings > Trigger Events,");
  console.log("  which should show a cron of */15 * * * *.\n");
  process.exit(1);
}

async function once() {
  console.log(`\n${B("Reel metrics — status")}\n`);

  const h = await get("/health").catch((e) => ({ status: 0, body: null, err: String(e) }));
  if (!h.body) {
    console.log(`  ${R("unreachable")}  ${cfg.URL}`);
    console.log(DIM(`  ${h.err || h.status}`));
    process.exit(1);
  }
  if (h.body.ok === false) {
    console.log(`  ${R("not ready")}   ${h.body.error}`);
    console.log(`  ${DIM("fix:")} ${h.body.hint}`);
    process.exit(1);
  }
  console.log(`  worker      ${G("reachable")}  ${DIM(cfg.URL)}`);
  console.log(`  schema      ${G(h.body.schema)}`);

  if (!h.body.polled_yet) {
    console.log(`  polls       ${Y("none yet")} — force one:`);
    console.log(DIM(`              curl -X POST "$URL/poll?key=$KEY"`));
    process.exit(0);
  }

  // Cadence first: "last poll 6 min ago" looks identical on a cron that runs
  // every 15 minutes and one that fired once and stopped for a day.
  if (h.body.polls_24h != null) {
    const n = h.body.polls_24h, exp = h.body.polls_24h_expected || 96;
    const pct = Math.round((n / exp) * 100);
    const gap = h.body.worst_gap_min;
    const healthy = pct >= 80 && (gap == null || gap <= 35);
    console.log(`  cadence     ${n}/${exp} polls in 24h (${pct}%)` +
      (gap != null ? `, worst gap ${gap} min` : "") + "  " +
      (healthy ? G("steady") : pct >= 40 ? Y("intermittent") : R("badly degraded")));
    if (h.body.polls_failed_24h > 0)
      console.log(`              ${Y(h.body.polls_failed_24h + " failed")}`);
  }

  const age = mins(h.body.last_poll_at);
  const ok = h.body.last_poll_ok;
  console.log(`  last poll   ${clock(h.body.last_poll_at)}, ${age.toFixed(0)} min ago  ` +
    (ok ? G("ok") : R("FAILED")));

  // The cron runs every 15 minutes, so a healthy system is never much more
  // than that behind. Beyond ~35 minutes something has stopped.
  if (age < 20) console.log(`  cron        ${G("firing")}  ${DIM("(a poll landed inside the 15-min window)")}`);
  else if (age < 35) console.log(`  cron        ${Y("probably fine")}  ${DIM("run --watch to be sure")}`);
  else console.log(`  cron        ${R("NOT firing")}  ${DIM("last poll is older than two intervals")}`);

  const s = await get("/summary", true);
  if (s.status !== 200 || !s.body) {
    console.log(`  summary     ${R("failed")} (status ${s.status}) — is the API key right?`);
    process.exit(1);
  }
  const b = s.body;
  if (b.error) { console.log(`  summary     ${Y(b.error)}`); process.exit(0); }

  const hh = b.health?.history_hours ?? 0;
  console.log(`  history     ${hh.toFixed(1)} h  ${DIM("since " + clock(b.health.history_since))}`);

  // Which delta windows have enough history behind them to mean anything.
  const d = b.latest?.deltas?.views || {};
  const live = Object.entries(d).filter(([, v]) => v != null).map(([k]) => k);
  const pending = Object.entries(d).filter(([, v]) => v == null).map(([k]) => k);
  console.log(`  deltas      ${live.length ? G(live.join(", ") + " live") : DIM("none yet")}` +
    (pending.length ? DIM(`  ·  ${pending.join(", ")} still collecting`) : ""));

  const td = b.health?.token_days_left;
  const refreshOverdue = td != null && td < 15;
  console.log(`  token       ${td == null ? DIM("unknown")
    : refreshOverdue ? R(td + " days left — auto-refresh has not run")
    : G(td + " days left")}`);

  const L = b.latest;
  if (L) {
    console.log(`  tracked     ${b.reels.length} reels · newest ${L.age_hours}h old ` +
      `at ${Math.round(L.metrics.views).toLocaleString("en-IN")} views`);
  }

  console.log();
  if (refreshOverdue) {
    console.log(`  ${R("Action needed:")} the Worker refreshes the token at 15 days left, so`);
    console.log(`  ${td} days means the refresh has failed. There is no automated recovery`);
    console.log("  once it expires — you would re-authorise by hand. Check the logs:");
    console.log(DIM("      wrangler tail"));
    console.log("  and force a refresh cycle by redeploying, or regenerate the token in the");
    console.log("  Meta dashboard and re-run ./deploy.sh.\n");
  } else if (age >= 35) {
    console.log(`  ${R("Action needed:")} the cron has stopped. Run  node check.mjs --watch  to confirm,`);
    console.log("  then check Trigger Events in the Cloudflare dashboard.\n");
  } else if (hh < 1) {
    console.log(DIM("  Too early for deltas. Check back in a few hours; 24h windows fill last.\n"));
  } else {
    console.log(DIM("  Nothing needs you. Next checkpoint: around 25 Oct, confirm the token refreshed.\n"));
  }
}

if (process.argv.includes("--watch")) await watch();
else await once();
