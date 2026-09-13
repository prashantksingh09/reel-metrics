# Reel Metrics

An Instagram reel dashboard that lives on your iPhone home screen, built
around one fact about Meta's API:

> **It gives you a snapshot, never a history.**

Ask for a reel's view count and you get today's number. Ask again tomorrow and
you get tomorrow's, with yesterday's gone for good. Every "+1,200 views in the
last hour" you might want has to be computed from a table you keep yourself.

That table is the whole point of this project. A Cloudflare Worker polls your
reels every 15 minutes and stores what changed; a Scriptable widget renders it.
Nothing here is a prettier view of what Instagram already shows you — it's the
thing Instagram structurally cannot show you, which is *how fast* a reel is
moving right now.

Runs entirely inside free tiers. No Apple Developer account, no Mac needed for
the widget, no server to maintain.

---

## What it looks like

| Size | Shows |
|---|---|
| Small | Latest reel's views, movement in the last hour, age, likes |
| Medium | The above plus likes / comments / shares / saved / average watch time, with a sparkline |
| Large | All of that, plus your five tracked reels on a log scale and an account line |

---

## Architecture

```
Meta Graph API  (graph.instagram.com)
        |  every 15 min
        v
Cloudflare Worker  ──writes──>  D1 (SQLite)
        |                        the only history that will ever exist
        |  reads + diffs
        v
   GET /summary.json  ──>  Scriptable widget on iOS
```

The server owns the arithmetic; the widget only draws. That split is
deliberate: **iOS decides when a widget refreshes**, treating your requested
interval as a suggestion, so any calculation done on the phone would be
calculation done at an unknown time.

---

## Setup

Three stages, roughly an evening in total. Most of it is waiting for Meta's
dashboard to load.

### 1. Get a token — `phase0/`

You need an Instagram **Business or Creator** account. The insights endpoints
return nothing for personal accounts and there is no workaround.

At [developers.facebook.com](https://developers.facebook.com), create a
**Business**-type app (this cannot be changed later), add the **Instagram**
product, and choose **API setup with Instagram business login** — not the
Facebook Login route, which wants a Facebook Page and talks to a different
host.

Grant **both** permissions:

```
instagram_business_basic
instagram_business_manage_insights
```

Missing the second is the single most common way to get a token that appears to
work — your profile and media load fine — while every insights call comes back
empty. Permissions are baked into a token when it's generated and cannot be
added afterwards.

Then generate a token and run:

```bash
cd phase0
cp .env.example .env      # paste the token in
python3 token_tool.py check
python3 probe.py
```

See [`phase0/README.md`](phase0/README.md) for what these do and why.

### 2. Deploy the backend — `worker/`

Needs a free Cloudflare account — genuinely free, and it doesn't ask for a card.

```bash
cd worker
wrangler login
./deploy.sh
```

`deploy.sh` creates the D1 database and writes its id into `wrangler.toml`
itself, applies the schema against the **remote** database, sets your secrets,
deploys, and then verifies by forcing a poll and reading the summary back. It's
safe to re-run.

See [`worker/README.md`](worker/README.md) for the manual equivalent and the
design constraints.

### 3. Install the widget — `widget/`

Install **Scriptable** (free, App Store), paste your Worker URL and API key
into the top of `reel-metrics.js`, get it onto your phone, then add the widget
**from the home screen** — not from inside Scriptable.

See [`widget/README.md`](widget/README.md).

---

## Things that look like bugs and aren't

**"collecting…" where a number should be.** There's no reading old enough to
compare against yet. The 1-hour window fills first, 24-hour last. Zero would be
a lie, so it doesn't say zero.

**Counters going down.** Two probe runs eleven minutes apart showed a reel's
share count *fall by two*. People delete shares, and Meta revises figures after
the fact. Negative deltas are real results and are never clamped away.

**Bars that aren't proportional.** They're log-scaled, and labelled as such. A
breakout reel can beat an ordinary one by two orders of magnitude; on a linear
scale everything else becomes a sliver.

**The widget not updating when you expect.** iOS budgets widget refreshes. This
is why a timestamp is always on screen.

**Watch time that can't become a completion rate.** The API gives no video
duration, so a 25-second average means something different on a 30-second reel
than a 90-second one. `reels_skip_rate` is the retention figure that *is*
normalised, which is why it's tracked.

---

## Known constraints

- **Cloudflare's cron triggers proved unreliable** in practice — several
  multi-hour stalls where the trigger was registered and simply didn't fire.
  `GET /health` reports `polls_24h` against the 96 expected and the worst gap
  between polls, so you can measure this rather than guess. If it stalls for
  you too, point any external cron service at `POST /poll?key=…` and take
  Cloudflare's scheduler out of the critical path.
- **A reel stops being tracked once five newer ones exist.** Its stored history
  is kept, just not extended. Raise `REELS_TRACKED` in `worker/src/config.js`.
- **Account-level `views` and `reach` are daily figures that reset**, not
  running totals. Never label them "total" and never diff them.
- **Tokens last 60 days** and can only be refreshed while still valid and at
  least 24 hours old. The Worker refreshes at 15 days remaining. If you ever
  see fewer than 15 days left, the automatic refresh has already failed — there
  is no recovery once it expires beyond re-authorising by hand.

---

## Licence

MIT — see [LICENSE](LICENSE).
