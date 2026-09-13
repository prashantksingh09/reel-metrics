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
  // From worker/.deploy-info after you deploy. BOTH VALUES MUST BE IN QUOTES --
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

// Instagram's palette pulled 30% toward neutral grey. Muting the colours
// directly rather than making the widget translucent keeps it identical on a
// light and a dark home screen -- a translucent version measured 2.5:1 against
// white text on a light wallpaper, which is unreadable outdoors.
// Measured 3.73:1 for white text on the worst stop: marginally better than the
// fully saturated original.
const GRAD = ["#8857B2", "#A84F9B", "#C34473", "#D0635D"];

// Secondary text was 74% and 56% white, landing at 2.7:1 and 2.2:1 -- which is
// why those lines read as faint rather than merely quiet. Raised as far as the
// hierarchy allows: pushing everything to 100% would fix contrast and flatten
// the design into one shouting voice.
const INK = new Color("#FFFFFF");
const DIM = new Color("#FFFFFF", 0.90);
const FAINT = new Color("#FFFFFF", 0.78);

// ---------------------------------------------------------------- formatting

/** Full digits while precision matters, compact once it stops.
 *  2,026 reads better than "2.0K" on a reel you posted this morning;
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
  // Floored, not rounded, and switching to days at exactly 24h.
  //
  // Rounding produced two wrong answers. At 23.9 hours it said "24h", a unit
  // that should not exist. And a 47.7-hour reel became "2d" while Instagram
  // itself calls the same reel "1d" -- a disagreement you would notice
  // immediately, since the widget sits next to the app it is reporting on.
  // Flooring matches how elapsed time is counted everywhere: you are 1 day
  // old until the moment you are 2.
  if (hours < 24) return Math.floor(hours) + "h";
  return Math.floor(hours / 24) + "d";
}

function clockOf(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Bar length, stretched between the smallest and largest tracked reel.
 *
 *  Scaling against the maximum alone crowds everything at the top: five reels
 *  spanning 2.4k to 300k rendered as 62/62/100/71/68, which says almost
 *  nothing about the four ordinary ones. Normalising between min and max
 *  separates them.
 *
 *  The guard matters. Normalising assumes there IS a spread; when every reel
 *  lands within roughly 2x of the others -- an ordinary week -- the same maths
 *  magnifies a 1.7x difference into a 10x-looking chart. Below that threshold
 *  the bars compress toward the middle instead, so a quiet week reads as one.
 *
 *  Floored at 14%, not 0: at 10% the smallest reel's fill was so short it read
 *  as an empty track rather than a low bar. */
function barFrac(v, min, max) {
  const lv = Math.log10(Math.max(v || 1, 1));
  const lo = Math.log10(Math.max(min || 1, 1));
  const hi = Math.log10(Math.max(max || 10, 10));
  const span = hi - lo;
  if (!isFinite(span) || span <= 0) return 0.6;
  const t = Math.max(0, Math.min(1, (lv - lo) / span));
  if (span < 0.3) return 0.55 + 0.30 * t;
  return 0.14 + 0.86 * t;
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

/** SF Symbols stand in for the SVG icons in the design: Scriptable renders no
 *  SVG, and Apple's set is both closer to the mockup and native to iOS.
 *  Wrapped because a missing symbol name throws, and a widget that throws
 *  shows a blank rectangle with no way to tell why. */
function icon(stack, name, size) {
  try {
    const sym = SFSymbol.named(name);
    if (!sym) return null;
    sym.applyFont(Font.systemFont(size));
    const img = stack.addImage(sym.image);
    img.imageSize = new Size(size, size);
    img.tintColor = INK;
    img.resizable = false;
    return img;
  } catch (e) {
    return null;
  }
}

// Fixed because a flexible stack cannot report its own width, and the fill
// has to be drawn as a fraction of the track.
const BAR_W = 186;

const STATS = [
  { key: "likes",    sym: "heart.fill" },
  { key: "comments", sym: "bubble.right" },
  { key: "shares",   sym: "arrow.up" },
  { key: "saved",    sym: "bookmark.fill" },
];

/** One icon + number pair. */
function statPair(row, sym, value, size, gap) {
  const cell = row.addStack();
  cell.centerAlignContent();
  cell.spacing = gap;
  icon(cell, sym, size);
  label(cell, fmt(value), size + 0.5, INK, "bold");
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

/** The headline number, its delta, and what the delta measures.
 *
 *  Laid out per size rather than one arrangement for all three. Putting the
 *  number, the delta and the label on a single row needs ~177pt on the small
 *  widget, which has 132 -- Scriptable's answer to that is to truncate, so the
 *  view count rendered as "2,4…". The medium was overflowing too, just not
 *  visibly yet.
 *
 *    small   number
 *            +3  views · 1h
 *    medium  number  +120
 *            views · last 1h
 *    large   number  +120  views · last 1h        (306pt: fits)
 */
function headline(stack, reel, windowKey, size, mode) {
  const views = fmt(reel?.metrics?.views);
  const d = reel?.deltas?.views?.[windowKey];
  const delta = fmtDelta(d);
  const span = mode === "small" ? `views · ${windowKey}` : `views · last ${windowKey}`;

  const col = stack.addStack();
  col.layoutVertically();
  col.spacing = 2;

  if (mode === "large") {
    const row = col.addStack();
    row.bottomAlignContent();
    row.spacing = 8;
    label(row, views, size, INK, "bold");
    if (delta == null) { label(row, "collecting…", 11.5, FAINT, "medium"); return; }
    label(row, delta, 11.5, INK, "bold");
    label(row, span, 11.5, DIM);
    return;
  }

  if (mode === "medium") {
    const top = col.addStack();
    top.bottomAlignContent();
    top.spacing = 8;
    label(top, views, size, INK, "bold");
    if (delta != null) label(top, delta, 11.5, INK, "bold");
    label(col, delta == null ? "collecting…" : span, 11.5,
          delta == null ? FAINT : DIM, delta == null ? "medium" : undefined);
    return;
  }

  // small: the number gets a line to itself, because it is the whole point of
  // this size and the only thing that must never be abbreviated.
  label(col, views, size, INK, "bold");
  const line = col.addStack();
  line.centerAlignContent();
  line.spacing = 6;
  if (delta == null) {
    label(line, "collecting…", 11.5, FAINT, "medium");
  } else {
    label(line, delta, 11.5, INK, "bold");
    label(line, span, 11.5, DIM);
  }
}

/** Views over the window, full width. This is what fills the space the old
 *  large layout left empty. */
function sparkRow(stack, reel, width, height) {
  const img = sparkline(reel?.views_series, width, height);
  if (img) {
    const w = stack.addImage(img);
    w.resizable = false;
  } else {
    // No series yet: hold the space rather than letting everything below jump
    // up by 30pt once history arrives.
    stack.addSpacer(height);
  }
}

function hairline(stack) {
  const r = stack.addStack();
  r.size = new Size(0, 1);
  r.backgroundColor = new Color("#FFFFFF", 0.24);
}

/** The four stats. On the small widget, four columns of five-digit numbers do
 *  not fit -- so once the values get long it drops the least-consulted one.
 *  Likes, comments and shares survive; saves is the one that goes. */
function statsRow(stack, metrics, size, gap, allowDrop) {
  const m = metrics || {};
  let set = STATS;
  if (allowDrop) {
    const width = STATS.reduce((n, st) => n + fmt(m[st.key]).length, 0);
    if (width > 14) set = STATS.slice(0, 3);
  }
  const row = stack.addStack();
  row.centerAlignContent();
  set.forEach((st, i) => {
    statPair(row, st.sym, m[st.key], size, 4);
    if (i < set.length - 1) row.addSpacer();
  });
  return row;
}

function smallWidget(w, data) {
  header(w, data);
  const reel = data.body?.latest;
  if (!reel) { w.addSpacer(6); label(w, "no data yet", 13, DIM); return; }

  w.addSpacer();
  headline(w, reel, "1h", 31, "small");
  w.addSpacer(7);
  sparkRow(w, reel, 130, 26);
  w.addSpacer(7);
  statsRow(w, reel.metrics, 11, 4, true);
}

function mediumWidget(w, data) {
  header(w, data);
  const reel = data.body?.latest;
  if (!reel) { w.addSpacer(6); label(w, "no data yet", 13, DIM); return; }

  w.addSpacer(5);
  const body = w.addStack();
  body.bottomAlignContent();
  body.spacing = 12;

  const left = body.addStack();
  left.layoutVertically();
  headline(left, reel, "1h", 33, "medium");

  sparkRow(body, reel, 150, 34);

  w.addSpacer(9);
  hairline(w);
  w.addSpacer(8);

  const row = statsRow(w, reel.metrics, 14, 5, false);
  row.addSpacer();
  const watch = reel.metrics?.ig_reels_avg_watch_time;
  if (watch != null) label(row, `${fmtMs(watch)} avg watch`, 10.5, FAINT);
}

/** One reel: a track, its fill, the number and the age.
 *  Track width is fixed rather than flexible because the fill has to be drawn
 *  as a fraction of it, and a flexible stack cannot report its own width. */
function reelRow(stack, reel, min, max) {
  const row = stack.addStack();
  row.centerAlignContent();
  row.spacing = 9;

  const link = TAP_OPENS_REEL ? safeUrl(reel.permalink) : null;
  if (link) row.url = link;

  const track = row.addStack();
  track.size = new Size(BAR_W, 7);
  track.backgroundColor = new Color("#FFFFFF", 0.26);
  track.cornerRadius = 3.5;

  const fill = track.addStack();
  fill.size = new Size(
    Math.max(6, Math.round(BAR_W * barFrac(reel.metrics?.views, min, max))), 7);
  fill.backgroundColor = new Color("#FFFFFF", 0.92);
  fill.cornerRadius = 3.5;

  row.addSpacer();
  const num = row.addStack();
  num.size = new Size(58, 0);
  num.addSpacer();
  label(num, fmt(reel.metrics?.views), 12.5, INK, "bold");

  const age = row.addStack();
  age.size = new Size(26, 0);
  age.addSpacer();
  label(age, fmtAge(reel.age_hours), 10, FAINT);
}

function largeWidget(w, data) {
  header(w, data);
  const b = data.body;
  if (!b || !b.reels?.length) { w.addSpacer(6); label(w, "no data yet", 13, DIM); return; }

  w.addSpacer(7);
  headline(w, b.latest, "1h", 37, "large");
  w.addSpacer(7);
  sparkRow(w, b.latest, 300, 30);

  w.addSpacer(8);
  hairline(w);
  w.addSpacer(7);
  statsRow(w, b.latest?.metrics, 14, 5, false);

  const m = b.latest?.metrics || {};
  if (m.reels_skip_rate != null || m.ig_reels_avg_watch_time != null) {
    w.addSpacer(4);
    const bits = [];
    if (m.reels_skip_rate != null) bits.push(`${m.reels_skip_rate.toFixed(0)}% skipped`);
    if (m.ig_reels_avg_watch_time != null) bits.push(`${fmtMs(m.ig_reels_avg_watch_time)} avg watch`);
    label(w, bits.join(" · "), 10.5, FAINT);
  }

  w.addSpacer(9);
  const cap = w.addStack();
  cap.centerAlignContent();
  label(cap, "RECENT REELS", 9, FAINT, "medium");
  cap.addSpacer();
  label(cap, "log scale", 9.5, FAINT);
  w.addSpacer(6);

  const views = b.reels.map((r) => r.metrics?.views || 0).filter((v) => v > 0);
  const min = views.length ? Math.min(...views) : 1;
  const max = views.length ? Math.max(...views) : 10;

  const list = w.addStack();
  list.layoutVertically();
  list.spacing = 4;
  b.reels.forEach((r) => reelRow(list, r, min, max));

  w.addSpacer();
  const foot = w.addStack();
  foot.centerAlignContent();
  const acc = b.account?.metrics || {};
  const fd = b.account?.followers_delta_7d;
  label(foot, `${fmt(acc.followers_count)} followers`, 12, DIM, "medium");
  if (fd != null && fd !== 0) label(foot, `  ${fmtDelta(fd)}`, 12, FAINT);
  foot.addSpacer();
  // Account reach is a DAILY figure that resets, not a running total, so it is
  // labelled as such and never called "total".
  if (acc.reach != null) label(foot, `${fmt(acc.reach)} reach today`, 12, FAINT);
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
