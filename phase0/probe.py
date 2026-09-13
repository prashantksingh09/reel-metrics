#!/usr/bin/env python3
"""
Phase 0 probe -- Instagram reel metrics project.

Answers three questions before any real code gets written:
  1. Does the token work, and what account is behind it?
  2. Which of my media are actually reels, and how do I tell?
  3. Which insight metrics does Meta *actually* return for my reels?

Question 3 is the important one. The metric vocabulary changed in Apr 2025
(plays and impressions retired in favour of views) and availability still
differs between a fresh reel and an old one. So rather than trusting any
documentation -- including mine -- this probes each metric individually
against a real reel and reports what came back.

Stdlib only. No pip install. Run it, then send me the JSON it writes.

Usage:
    export IG_ACCESS_TOKEN='your_long_lived_token'
    python3 probe.py

or put the token in a .env file next to this script:
    IG_ACCESS_TOKEN=...
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent

# graph.instagram.com is the host for the "Instagram API with Instagram Login"
# path we picked. The older Facebook-Login path uses graph.facebook.com -- if
# you ever switch, override with IG_API_HOST rather than editing this.
HOST = os.environ.get("IG_API_HOST", "graph.instagram.com")
VERSION = os.environ.get("IG_API_VERSION", "v26.0")
REELS_TO_PROBE = int(os.environ.get("IG_REELS", "5"))

# Meta's error for a bogus metric enumerates every valid one, so we don't have
# to guess. These are only the fallback if that parsing ever stops working,
# plus the three retired names we probe deliberately to watch them fail.
FALLBACK_METRICS = [
    "views", "reach", "likes", "comments", "shares", "saved",
    "total_interactions", "navigation", "reels_skip_rate",
    "ig_reels_avg_watch_time", "ig_reels_video_view_total_time",
]

RETIRED_METRICS = ["plays", "impressions", "video_views"]

# Threads metrics come back in the same list but belong to a different product.
SKIP_PREFIXES = ("thread_", "threads_")

ACCOUNT_METRIC_CANDIDATES = [
    "reach", "views", "profile_views", "accounts_engaged",
    "total_interactions", "likes", "comments", "shares", "saves",
    "follows_and_unfollows",
]

# Metrics Meta reports in milliseconds. Worth knowing before you put a raw
# 5707057176 on a widget and wonder why it says five billion.
MS_METRICS = {"ig_reels_avg_watch_time", "ig_reels_video_view_total_time"}


def human_ms(v):
    try:
        sec = float(v) / 1000.0
    except (TypeError, ValueError):
        return str(v)
    if sec < 60:
        return f"{sec:.1f}s"
    if sec < 3600:
        return f"{sec/60:.1f}m"
    if sec < 86400:
        return f"{sec/3600:.1f}h"
    return f"{sec/86400:.1f}d"


def _die(msg):
    print(f"\n  {msg}\n", file=sys.stderr)
    sys.exit(1)


def load_token():
    token = os.environ.get("IG_ACCESS_TOKEN", "").strip()
    if token:
        return token
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith("IG_ACCESS_TOKEN="):
                return line.split("=", 1)[1].strip().strip("'\"")
    _die("No token. Set IG_ACCESS_TOKEN, or put it in a .env next to this script.\n"
         "  See .env.example.")


def get(path, token, **params):
    """GET a Graph path. Returns (ok, payload). Never raises on API errors --
    the error body is the interesting part when probing."""
    params["access_token"] = token
    url = f"https://{HOST}/{VERSION}/{path.lstrip('/')}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "phase0-probe/1.0"})
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return False, json.loads(body)
        except json.JSONDecodeError:
            return False, {"error": {"message": body, "http_status": e.code}}
    except Exception as e:
        # Transport failure, not an API verdict. Worth distinguishing -- otherwise
        # a dropped connection reads as "your token is bad" and you chase the
        # wrong problem for an hour.
        return False, {"error": {"message": f"{type(e).__name__}: {e}"},
                       "_transport_error": True}


def unwrap(payload):
    """Meta's docs show /me returning {"data":[{...}]} while the API has
    historically returned a flat object. Accept either rather than betting."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), list) \
            and payload["data"] and "error" not in payload:
        return payload["data"][0]
    return payload


def err_text(payload):
    e = payload.get("error", {})
    return e.get("error_user_msg") or e.get("message") or json.dumps(e)[:300]


def discover_metrics(media_id, token):
    """Ask for a metric that cannot exist. Meta refuses and, helpfully, lists
    every metric that *does* exist for this media type. That list is the
    authority -- it updates itself when Meta changes things, which a hardcoded
    list in this file never will."""
    ok, res = get(f"{media_id}/insights", token, metric="__does_not_exist__")
    if ok:
        return None
    msg = err_text(res)
    marker = "must be one of the following values:"
    if marker not in msg:
        return None
    names = [n.strip() for n in msg.split(marker, 1)[1].split(",")]
    names = [n for n in names if n and n.replace("_", "").isalnum()]
    return [n for n in names if not n.startswith(SKIP_PREFIXES)] or None


def main():
    sys.stdout.reconfigure(line_buffering=True)
    token = load_token()
    stamp = datetime.now(timezone.utc)
    dump = {
        "probed_at": stamp.isoformat(),
        "host": HOST,
        "api_version": VERSION,
    }

    print(f"\n  Probing {HOST}/{VERSION}\n")

    # --- 1. Who am I? ------------------------------------------------------
    ok, me = get("me", token,
                 fields="id,user_id,username,name,account_type,"
                        "media_count,followers_count,follows_count")
    if not ok:
        if me.get("_transport_error"):
            _die("Could not reach the API at all -- this is a network problem,\n"
                 f"  not a token problem.\n\n  {err_text(me)}\n\n"
                 "  Run this from your own Terminal on a normal connection.")
        _die("Token rejected at /me -- nothing else can work.\n"
             f"  {err_text(me)}\n\n"
             "  Most likely: the token expired (they last 60 days), or it was\n"
             "  issued for the Facebook-Login path -- try IG_API_HOST=graph.facebook.com")
    me = unwrap(me)
    dump["me"] = me
    print(f"  account   @{me.get('username')}  ({me.get('account_type')})")
    print(f"  media     {me.get('media_count')}   followers  {me.get('followers_count')}")

    # --- 2. What counts as a reel? ----------------------------------------
    ok, media = get("me/media", token,
                    fields="id,media_type,media_product_type,timestamp,permalink,caption",
                    limit=25)
    if not ok:
        ig_id = me.get("user_id") or me.get("id")
        ok, media = get(f"{ig_id}/media", token,
                        fields="id,media_type,media_product_type,timestamp,"
                               "permalink,caption",
                        limit=25)
    if not ok:
        _die(f"Could not list media: {err_text(media)}")
    items = media.get("data", [])
    dump["media_sample"] = items

    # media_type alone says VIDEO for both reels and ordinary videos.
    # media_product_type is what actually separates them.
    combos = {}
    for m in items:
        key = f"{m.get('media_type')} / {m.get('media_product_type')}"
        combos[key] = combos.get(key, 0) + 1
    dump["media_type_combinations"] = combos

    print(f"\n  {len(items)} recent media, by media_type / media_product_type:")
    for k, v in sorted(combos.items(), key=lambda kv: -kv[1]):
        print(f"    {v:>3}  {k}")

    reels = [m for m in items if m.get("media_product_type") == "REELS"]
    if not reels:
        _die("No REELS found in the last 25 media. Post one, or raise the limit.")
    print(f"\n  {len(reels)} reels found; probing metrics against the newest.")

    # --- 3. Which metrics are real? ---------------------------------------
    # One metric per call. Slower, but it distinguishes "this metric is dead"
    # from "this whole request was malformed", which a batched call cannot.
    probe_target = reels[0]

    discovered = discover_metrics(probe_target["id"], token)
    if discovered:
        print(f"\n  Meta lists {len(discovered)} valid metrics for this media type.")
        candidates = discovered + [m for m in RETIRED_METRICS if m not in discovered]
    else:
        print("\n  Could not read the valid-metric list; using the fallback set.")
        candidates = FALLBACK_METRICS + RETIRED_METRICS
    dump["metrics_meta_advertises"] = discovered

    supported, rejected = [], {}
    for metric in candidates:
        ok, res = get(f"{probe_target['id']}/insights", token, metric=metric)
        if ok and res.get("data"):
            supported.append(metric)
        else:
            rejected[metric] = err_text(res)

    dump["media_metrics"] = {
        "probe_target": probe_target,
        "supported": supported,
        "rejected": rejected,
    }

    print(f"\n  media metrics that work ({len(supported)}):")
    print("    " + (", ".join(supported) or "-- none --"))
    if rejected:
        print(f"\n  rejected ({len(rejected)}):")
        for m, why in rejected.items():
            print(f"    {m:<32} {why[:90]}")

    # --- 4. Real values, across the recent reels --------------------------
    dump["reels"] = []
    if supported:
        for reel in reels[:REELS_TO_PROBE]:
            ok, res = get(f"{reel['id']}/insights", token, metric=",".join(supported))
            values = {}
            if ok:
                for row in res.get("data", []):
                    vals = row.get("values") or [{}]
                    values[row["name"]] = vals[0].get("value")
            dump["reels"].append({
                "id": reel["id"],
                "timestamp": reel.get("timestamp"),
                "permalink": reel.get("permalink"),
                "caption": (reel.get("caption") or "")[:120],
                "insights": values,
                "error": None if ok else err_text(res),
            })

        print(f"\n  values for the {len(dump['reels'])} most recent reels:")
        for r in dump["reels"]:
            when = (r["timestamp"] or "")[:10]
            if r["error"]:
                print(f"    {when}   ERROR  {r['error'][:80]}")
            else:
                ins = r["insights"]
                core = {k: ins.get(k) for k in ("views", "likes", "comments", "shares", "saved")}
                line = "  ".join(f"{k}={v}" for k, v in core.items() if v is not None)
                if ins.get("ig_reels_avg_watch_time") is not None:
                    line += f"  avg_watch={human_ms(ins['ig_reels_avg_watch_time'])}"
                print(f"    {when}   {line}")

    # --- 5. Account-level -------------------------------------------------
    account_id = me.get("user_id") or me.get("id")
    acct_ok, acct_bad = [], {}
    for metric in ACCOUNT_METRIC_CANDIDATES:
        ok, res = get(f"{account_id}/insights", token,
                      metric=metric, period="day", metric_type="total_value")
        if ok and res.get("data"):
            acct_ok.append(metric)
        else:
            acct_bad[metric] = err_text(res)
    dump["account_metrics"] = {"supported": acct_ok, "rejected": acct_bad}

    print(f"\n  account metrics that work ({len(acct_ok)}):")
    print("    " + (", ".join(acct_ok) or "-- none --"))

    # --- 6. Save ----------------------------------------------------------
    out = HERE / f"phase0_dump_{stamp:%Y%m%d_%H%M%S}.json"
    blob = json.dumps(dump, indent=2, ensure_ascii=False)
    if token in blob:
        blob = blob.replace(token, "<REDACTED>")
        print("\n  (token found in the output and redacted before writing)")
    out.write_text(blob)
    print(f"\n  written  {out.name}")
    print("  Send that file over -- Phase 1 gets built against it.\n")

    if not supported:
        print("  NOTE: no media metrics worked. Almost certainly the token is missing\n"
              "  instagram_business_manage_insights -- insights need it *in addition*\n"
              "  to instagram_business_basic. Add it in the app's business login\n"
              "  settings, then generate a fresh token; scopes are baked in at\n"
              "  generation time and cannot be added to an existing token.\n")


if __name__ == "__main__":
    main()
