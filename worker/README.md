# Reel metrics — Cloudflare Worker

Polls @your_account's reel insights on a schedule, stores the history Meta
doesn't keep, and serves it as JSON for the iPhone widget.

Runs entirely inside Cloudflare's free plan: 100k requests/day, 5M D1 row
reads/day, 5GB storage. This uses a few hundred reads and a few dozen writes
a day.

## Why it's shaped this way

**Meta gives snapshots, never history.** Ask for a reel's views and you get
today's number; yesterday's is gone forever. Every "+1.2k in the last hour"
has to be computed from a table we keep. That table is the only irreplaceable
thing here — back it up before any destructive change.

**Rows are written only when a value changes.** Five reels × ten metrics ×
96 polls a day would be ~4,800 rows daily, nearly all restating that an old
reel still has the same view count. The value at any time T is the last row
at or before T.

**Counters go down.** Two probe runs eleven minutes apart showed a share
count fall by two — people delete shares, and Meta revises figures after the
fact. Negative deltas are real results and are never clamped.

**Errors come back localised.** One probe returned Marathi, because that's
the account's locale. Nothing in this code matches on error message text;
only on numeric codes.

**50 subrequests per invocation, and D1 queries count.** The naive
read-then-write-per-metric loop would issue ~100 D1 calls and fail. Reads are
gathered into single queries and writes go out as one `batch()`. A normal
poll costs 15; a full sweep 17; the worst case with the per-metric fallback
is 25.

## Deploy

You need a Cloudflare account (free, and unlike Fly it does not ask for a card).

### The short way

```bash
cd worker
wrangler login      # once; opens a browser
./deploy.sh
```

`deploy.sh` does every step below, checking each one: installs wrangler if
missing, creates the D1 database and writes its id into `wrangler.toml`
itself (the step most often got wrong by hand), applies the schema against
the *remote* database, reads your Instagram token out of `phase0/.env` so you
never paste it again, generates an API key, deploys, and then verifies by
forcing a first poll and reading the summary back.

It is safe to re-run — every step checks whether it has already been done,
and it reuses the API key it generated the first time rather than issuing a
new one.

Secrets are piped into `wrangler secret put`, never echoed and never passed
as arguments, so nothing lands in your shell history. The URL and key are
written to `worker/.deploy-info` (chmod 600, gitignored).

### The manual way

If you would rather see each step, or `deploy.sh` stops somewhere and you
want to continue by hand:

**1. Create the database**

```bash
wrangler d1 create reel-metrics
```

Copy the `database_id` it prints into `wrangler.toml`, replacing
`PASTE_THE_ID_FROM_d1_create_HERE`.

**2. Create the tables**

```bash
wrangler d1 execute reel-metrics --remote --file=schema.sql
```

`--remote` matters. Without it you build the schema in a local emulator and
the deployed Worker finds an empty database.

**3. Set the secrets**

```bash
wrangler secret put IG_ACCESS_TOKEN     # paste the 60-day token
wrangler secret put API_KEY             # see below
```

Generate an API key worth using:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

The Instagram app secret is *not* needed — `refresh_access_token` takes only
the token itself.

**4. Deploy**

```bash
wrangler deploy
```

**5. Check it**

```bash
curl https://reel-metrics.<your-subdomain>.workers.dev/health
curl -X POST "https://reel-metrics.<your-subdomain>.workers.dev/poll?key=YOUR_API_KEY"
curl "https://reel-metrics.<your-subdomain>.workers.dev/summary?key=YOUR_API_KEY"
```

The first `/summary` will show `deltas` of `null` everywhere and
`history_hours: 0`. That is correct, not broken — there is no history until
the second poll lands. Deltas fill in as the windows pass.

## Checking on it

```bash
cd worker
node check.mjs           # is everything healthy right now?
node check.mjs --watch   # wait and actually SEE the cron fire
```

Reads the URL and key from `.deploy-info`, so no secrets on the command line.

The one-shot infers cron health from how long ago the last poll was: under 20
minutes is fine, over 35 means it has stopped. `--watch` is the stronger
proof — it sits for up to 20 minutes waiting for the timestamp to move on its
own, which is the only way to be sure nothing you did triggered it.

It also flags the case that matters most: **fewer than 15 days left on the
token means the automatic refresh has already failed**, not that expiry is
merely approaching. The Worker refreshes at 15 days precisely so there is
room to notice.

## Endpoints

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness. Deliberately exposes no numbers. |
| `GET /summary?key=…` | key | Everything the widget renders. |
| `POST /poll?key=…&scope=all\|fresh` | key | Force a poll instead of waiting 15 minutes. |

The key also works as `Authorization: Bearer …`.

## Schedule

One cron, every 15 minutes. The handler picks the scope per tick:

- **top of the hour** — full sweep: every tracked reel including ones past
  the 14-day window, plus account-level insights
- **other three ticks** — recent reels only, where movement actually happens
- **03:00 UTC** — token refresh check, and prune `poll_run` past 30 days

## The token clock

The token lasts 60 days. It can be refreshed only while still valid *and*
at least 24 hours old, so there is no automated recovery from letting it
lapse — only re-authorising by hand.

The Worker refreshes with 15 days to spare and writes the new token to D1
(Workers secrets are read-only at runtime, so D1 is the only place it can
go). `/summary` reports `token_days_left`; if that ever starts falling below
15 and staying there, the refresh is failing and needs attention.
