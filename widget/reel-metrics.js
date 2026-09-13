// Reel metrics — Scriptable widget
// ---------------------------------------------------------------------------
// Paste this into Scriptable (iOS), fill in CONFIG below, then add a
// Scriptable widget to your home screen and pick this script.
//
// Values come from your Cloudflare Worker: worker/.deploy-info holds both.
//
// Design notes, because they are not obvious from the code:
//
// * The widget computes nothing. iOS decides when a widget refreshes -- your
//   requested cadence is a hint, not a promise -- so arithmetic done here
//   would be arithmetic done at an unknown time. The server owns the maths.
//
// * The last good response is cached on device. A failed fetch shows
//   yesterday's numbers marked stale, never an error card. An error card is
//   the worst possible resting state for something that lives on your home
//   screen and is mostly looked at in passing.
//
// * Deltas that come back null render as "collecting", not "+0". Until there
//   is a reading old enough to compare against, zero would be a lie.
//
// * The reel comparison uses a LOG scale. Real spread across the tracked
//   reels has been 2,026 to 287,473 views -- 140x. On a linear bar the four
//   ordinary reels are invisible. Bars are labelled with the real numbers so
//   the scale never has to be guessed at.
// ---------------------------------------------------------------------------

const CONFIG = {
  // Filled from worker/.deploy-info. BOTH VALUES MUST BE IN QUOTES --
  // without them JavaScript reads these as variable names and the script
  // dies with "ReferenceError: ... is not defined" before doing anything.
  url: "https://reel-metrics.YOUR-SUBDOMAIN.workers.dev",
  key: "PASTE_YOUR_API_KEY",
};

// Set to false to make the widget completely inert on tap. Use it to find out
// whether a tap problem comes from this script or from the widget's own
// configuration: with no URL set anywhere here, any browser that still opens
// is being opened by something other than this code.
const TAP_OPENS_REEL = true;

/** Catch the handful of ways this gets typed wrong, and name the one that
 *  happened. A raw exception on a home-screen widget tells you nothing. */
function configProblem() {
  const u = String(CONFIG.url || "").trim();
  const k = String(CONFIG.key || "").trim();
  if (!u || u.includes("YOUR-SUBDOMAIN")) return "The url is still the placeholder.";
  if (!k || k.includes("PASTE_YOUR")) return "The key is still the placeholder.";
  if (!/^https:\/\//.test(u)) return "The url must start with https://";
  if (/\s/.test(k)) return "The key has a space or line break in it - re-copy it.";
  if (k.length < 20) return `The key looks too short (${k.length} chars).`;
  return null;
}

// A trailing slash would produce "//summary", which 404s. Cheaper to strip
// than to explain.
const BASE = String(CONFIG.url || "").trim().replace(/\/+$/, "");
const KEY = String(CONFIG.key || "").trim();

// Instagram's palette, minus the pale yellow end which white text cannot sit
// on. The logo and wordmark are deliberately absent -- those are theirs.
const GRAD = ["#833AB4", "#C13584", "#E1306C", "#F56040"];
const INK = new Color("#FFFFFF");
const DIM = new Color("#FFFFFF", 0.72);
const FAINT = new Color("#FFFFFF", 0.45);
const SCRIM = new Color("#000000", 0.22);

// ---------------------------------------------------------------- formatting

/** Full digits while precision matters, compact once it stops.
 *  2,026 reads better than "2.0K" on a reel posted this morning;
 *  287,473 does not need its last three digits. */
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  n = Math.round(n);
  if (Math.abs(n) < 10000) return n.toLocaleString("en-IN");
  if (Math.abs(n) < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  return (n / 1000000).toFixed(2).replace(/\.00$/, "") + "M";
}

function fmtDelta(d) {
  if (d == null) return null;          // caller decides how to say "collecting"
  const r = Math.round(d);
  if (r === 0) return "±0";
  return (r > 0 ? "+" : "−") + fmt(Math.abs(r));
}

/** The API reports watch time in milliseconds. 5,707,057,176 is 66 days of
 *  human attention, not a bug. */
function fmtMs(ms) {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  if (s < 3600) return (s / 60).toFixed(1) + "m";
  if (s < 86400) return (s / 3600).toFixed(1) + "h";
  return (s / 86400).toFixed(1) + "d";
}

function fmtAge(hours) {
  if (hours == null) return "";
  if (hours < 1) return Math.round(hours * 60) + "m";
  if (hours < 48) return hours.toFixed(1).replace(/\.0$/, "") + "h";
  return Math.round(hours / 24) + "d";
}

function clockOf(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Bar length by order of magnitude. Linear would render every reel but the
 *  outlier as a nub. Floored at 12% so the smallest bar is still a bar. */
function logFrac(v, max) {
  if (!v || v <= 0 || !max || max <= 0) return 0.12;
  const f = Math.log10(v) / Math.log10(Math.max(max, 10));
  return Math.max(0.12, Math.min(1, f));
}

// -------------------------------------------------------------------- data

/** Only hand iOS a URL we are sure of.
 *
 *  A tap target is set from data the API returned, and if that value is ever
 *  malformed -- a bare host, a stray colon, anything with an explicit port --
 *  iOS opens a browser and shows "Not allowed to use restricted network
 *  port", which reads like a network fault and is really a bad string.
 *  Anything that does not look like a plain https Instagram link is dropped,
 *  and the tap falls back to opening Scriptable, which is harmless. */
function safeUrl(raw) {
  const u = String(raw || "").trim();
  if (/\s/.test(u)) return null;                               // no whitespace anywhere
  if (!/^https:\/\/(www\.)?instagram\.com\/[^:]*$/.test(u)) return null;  // right host, no port
  return u;
}

const FM = FileManager.local();
const CACHE = FM.joinPath(FM.documentsDirectory(), "reel-metrics-cache.json");

async function loadData() {
  try {
    const req = new Request(`${BASE}/summary?key=${encodeURIComponent(KEY)}`);
    req.timeoutInterval = 15;
    const body = await req.loadJSON();
    if (body && !body.error) {
      try { FM.writeString(CACHE, JSON.stringify({ at: new Date().toISOString(), body })); }
      catch (e) { /* cache is a convenience, never load-bearing */ }
      return { body, stale: false };
    }
    return fromCache(body?.error || "no data yet");
  } catch (e) {
    return fromCache(String(e).slice(0, 60));
  }
}

function fromCache(reason) {
  try {
    if (FM.fileExists(CACHE)) {
      const c = JSON.parse(FM.readString(CACHE));
      return { body: c.body, stale: true, cachedAt: c.at, reason };
    }
  } catch (e) { /* fall through */ }
  return { body: null, stale: true, reason };
}

// ------------------------------------------------------------------ chrome

function shell() {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = GRAD.map((c) => new Color(c));
  g.locations = [0, 0.38, 0.7, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;
  w.setPadding(14, 15, 14, 15);
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  return w;
}

function label(stack, text, size, color, weight) {
  const t = stack.addText(text);
  t.font = weight === "bold" ? Font.boldSystemFont(size)
    : weight === "medium" ? Font.mediumSystemFont(size)
    : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function header(w, data) {
  const row = w.addStack();
  row.centerAlignContent();
  const name = data.body?.account?.username ? "@" + data.body.account.username : "reel metrics";
  label(row, name, 11, DIM, "medium");
  row.addSpacer();
  label(row, data.stale ? "stale " + clockOf(data.cachedAt) : clockOf(data.body?.as_of), 10, FAINT);
}

/** A reel's views sparkline. Flat or single-point series draw nothing rather
 *  than a misleading straight line. */
function sparkline(series, width, height) {
  if (!series || series.length < 3) return null;
  const vals = series.map((p) => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  if (max === min) return null;

  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;

  const x = (i) => (i / (series.length - 1)) * (width - 2) + 1;
  const y = (v) => height - 2 - ((v - min) / (max - min)) * (height - 4);

  const line = new Path();
  line.move(new Point(x(0), y(vals[0])));
  for (let i = 1; i < vals.length; i++) line.addLine(new Point(x(i), y(vals[i])));
  dc.addPath(line);
  dc.setStrokeColor(new Color("#FFFFFF", 0.9));
  dc.setLineWidth(1.8);
  dc.strokePath();

  const dot = new Path();
  const r = 2.4;
  const lastV = vals[vals.length - 1];
  dot.addEllipse(new Rect(x(vals.length - 1) - r, y(lastV) - r, r * 2, r * 2));
  dc.addPath(dot);
  dc.setFillColor(INK);
  dc.fillPath();

  return dc.getImage();
}

// ----------------------------------------------------------------- layouts

function bigNumber(w, reel, windowKey) {
  const views = reel?.metrics?.views;
  label(w, fmt(views), 34, INK, "bold");

  const d = reel?.deltas?.views?.[windowKey];
  const txt = fmtDelta(d);
  const row = w.addStack();
  row.centerAlignContent();
  if (txt == null) {
    label(row, "collecting…", 11, FAINT, "medium");
  } else {
    label(row, txt, 12, INK, "bold");
    label(row, "  views · " + windowKey, 11, DIM);
  }
}

function smallWidget(w, data) {
  header(w, data);
  w.addSpacer(6);
  const reel = data.body?.latest;
  if (!reel) { label(w, "no data yet", 13, DIM); return; }
  bigNumber(w, reel, "1h");
  w.addSpacer();
  const foot = w.addStack();
  foot.centerAlignContent();
  label(foot, fmtAge(reel.age_hours) + " old", 10, FAINT);
  foot.addSpacer();
  label(foot, fmt(reel.metrics?.likes) + " ♥", 10, FAINT);
}

function statCell(row, value, name) {
  const cell = row.addStack();
  cell.layoutVertically();
  label(cell, value, 14, INK, "bold");
  label(cell, name, 9, FAINT);
}

function mediumWidget(w, data) {
  header(w, data);
  w.addSpacer(4);
  const reel = data.body?.latest;
  if (!reel) { label(w, "no data yet", 13, DIM); return; }

  const body = w.addStack();
  body.layoutHorizontally();

  const left = body.addStack();
  left.layoutVertically();
  bigNumber(left, reel, "1h");
  left.addSpacer(4);
  label(left, fmtAge(reel.age_hours) + " old · " + (reel.caption || "").slice(0, 22), 9, FAINT);

  body.addSpacer();

  const right = body.addStack();
  right.layoutVertically();
  const spark = sparkline(reel.views_series, 100, 34);
  if (spark) {
    const img = right.addImage(spark);
    img.resizable = false;
  } else {
    right.addSpacer(34);
  }

  w.addSpacer(8);
  const stats = w.addStack();
  stats.layoutHorizontally();
  const m = reel.metrics || {};
  statCell(stats, fmt(m.likes), "likes"); stats.addSpacer();
  statCell(stats, fmt(m.comments), "comments"); stats.addSpacer();
  statCell(stats, fmt(m.shares), "shares"); stats.addSpacer();
  statCell(stats, fmt(m.saved), "saved"); stats.addSpacer();
  statCell(stats, fmtMs(m.ig_reels_avg_watch_time), "avg watch");
}

function reelRow(stack, reel, maxViews, rank) {
  const row = stack.addStack();
  row.centerAlignContent();
  const link = TAP_OPENS_REEL ? safeUrl(reel.permalink) : null;
  if (link) row.url = link;

  label(row, String(rank), 9, FAINT);
  row.addSpacer(6);

  const barWrap = row.addStack();
  barWrap.layoutVertically();
  barWrap.size = new Size(118, 12);
  const bar = barWrap.addStack();
  bar.size = new Size(Math.round(118 * logFrac(reel.metrics?.views, maxViews)), 7);
  bar.backgroundColor = new Color("#FFFFFF", 0.82);
  bar.cornerRadius = 3.5;

  row.addSpacer(8);
  const n = label(row, fmt(reel.metrics?.views), 12, INK, "bold");
  n.lineLimit = 1;
  row.addSpacer();
  label(row, fmtAge(reel.age_hours), 9, FAINT);
}

function largeWidget(w, data) {
  header(w, data);
  w.addSpacer(4);
  const b = data.body;
  if (!b || !b.reels?.length) { label(w, "no data yet", 13, DIM); return; }

  mediumTop(w, b.latest);

  w.addSpacer(9);
  const cap = w.addStack();
  cap.centerAlignContent();
  label(cap, "RECENT REELS", 9, FAINT, "medium");
  cap.addSpacer();
  label(cap, "log scale", 8, FAINT);
  w.addSpacer(5);

  const maxViews = Math.max(...b.reels.map((r) => r.metrics?.views || 0));
  const list = w.addStack();
  list.layoutVertically();
  list.spacing = 5;
  b.reels.forEach((r, i) => reelRow(list, r, maxViews, i + 1));

  w.addSpacer();
  const foot = w.addStack();
  foot.centerAlignContent();
  const acc = b.account?.metrics || {};
  const fd = b.account?.followers_delta_7d;
  label(foot, fmt(acc.followers_count) + " followers", 10, DIM, "medium");
  if (fd != null && fd !== 0) label(foot, "  " + fmtDelta(fd) + " /7d", 10, FAINT);
  foot.addSpacer();
  // Account reach is a DAILY figure that resets, not a running total, so it
  // is labelled as such and never called "total".
  if (acc.reach != null) label(foot, fmt(acc.reach) + " reach today", 10, FAINT);
}

function mediumTop(w, reel) {
  if (!reel) return;
  const body = w.addStack();
  body.layoutHorizontally();
  const left = body.addStack();
  left.layoutVertically();
  bigNumber(left, reel, "1h");
  left.addSpacer(3);
  const m = reel.metrics || {};
  label(left, `${fmt(m.likes)} ♥  ${fmt(m.comments)} ✎  ${fmt(m.shares)} ↗  ${fmt(m.saved)} ⌘`,
    10, DIM);
  if (m.reels_skip_rate != null) {
    label(left, `${m.reels_skip_rate.toFixed(0)}% skipped · ${fmtMs(m.ig_reels_avg_watch_time)} avg watch`,
      9, FAINT);
  }
  body.addSpacer();
  const right = body.addStack();
  right.layoutVertically();
  const spark = sparkline(reel.views_series, 96, 40);
  if (spark) right.addImage(spark).resizable = false;
}

// -------------------------------------------------------------------- main

async function run() {
  const bad = configProblem();
  if (bad) {
    const w = shell();
    label(w, "Config problem", 15, INK, "bold");
    w.addSpacer(4);
    label(w, bad, 11, DIM).lineLimit = 3;
    w.addSpacer(6);
    label(w, "Edit CONFIG at the top of this script.", 9, FAINT).lineLimit = 2;
    label(w, "Both values need quotes around them.", 9, FAINT).lineLimit = 2;
    return w;
  }

  const data = await loadData();
  const w = shell();

  if (!data.body) {
    header(w, data);
    w.addSpacer(8);
    label(w, "Can't reach the Worker", 13, INK, "bold");
    w.addSpacer(3);
    label(w, data.reason || "check CONFIG at the top", 10, DIM).lineLimit = 3;
    return w;
  }

  const family = config.runsInWidget ? config.widgetFamily : "large";
  if (family === "small") smallWidget(w, data);
  else if (family === "medium") mediumWidget(w, data);
  else largeWidget(w, data);

  const top = TAP_OPENS_REEL ? safeUrl(data.body.latest?.permalink) : null;
  if (top && !w.url) w.url = top;

  // A token nearing expiry is the one failure with no automated recovery,
  // so it gets shouted about on the widget itself rather than buried.
  const left = data.body.health?.token_days_left;
  if (left != null && left < 10) {
    w.addSpacer(4);
    label(w, `⚠︎ token expires in ${Math.round(left)}d`, 9, new Color("#FFE08A"), "bold");
  }
  return w;
}

const widget = await run();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentLarge();
Script.complete();
