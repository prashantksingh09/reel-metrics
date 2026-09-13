#!/usr/bin/env python3
"""Work out which kind of token you have, and upgrade it if needed.

    python3 token_tool.py check      # what have I got?
    python3 token_tool.py exchange   # short-lived -> 60 days

Why this exists: a short-lived token (1 hour) and a long-lived one (60 days)
look identical and behave identically until the short one dies. The only
difference you can observe is time.

Secrets are typed at a hidden prompt, never passed as arguments -- a token or
app secret in a shell command lands in ~/.zsh_history permanently.

Stdlib only.
"""
import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from getpass import getpass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV = HERE / ".env"
HOST = "graph.instagram.com"
VERSION = "v26.0"


def read_env_token():
    if not ENV.exists():
        return None, None
    for line in ENV.read_text().splitlines():
        if line.strip().startswith("IG_ACCESS_TOKEN="):
            token = line.split("=", 1)[1].strip().strip("'\"")
            if token and not token.startswith("paste_"):
                mtime = datetime.fromtimestamp(ENV.stat().st_mtime, tz=timezone.utc)
                return token, mtime
    return None, None


# Meta documents the two token endpoints WITHOUT a version prefix, unlike
# every data endpoint. Matching the docs exactly rather than assuming the
# versioned form also works -- this is the call that must not fail.
UNVERSIONED = {"access_token", "refresh_access_token"}


def api(path, **params):
    base = f"https://{HOST}" if path in UNVERSIONED else f"https://{HOST}/{VERSION}"
    url = f"{base}/{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "token-tool/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30,
                                    context=ssl.create_default_context()) as r:
            return True, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return False, json.loads(e.read().decode())
        except json.JSONDecodeError:
            return False, {"error": {"message": f"HTTP {e.code}"}}
    except Exception as e:
        return False, {"error": {"message": f"{type(e).__name__}: {e}",
                                 "_transport": True}}


def err(payload):
    e = payload.get("error", {})
    return f"code={e.get('code')} subcode={e.get('error_subcode')}: {e.get('message')}"


def write_token(token):
    lines = []
    if ENV.exists():
        lines = [l for l in ENV.read_text().splitlines()
                 if not l.strip().startswith("IG_ACCESS_TOKEN=")]
    lines.insert(0, f"IG_ACCESS_TOKEN={token}")
    ENV.write_text("\n".join(lines) + "\n")
    ENV.chmod(0o600)


def cmd_check():
    token, saved_at = read_env_token()
    if not token:
        print("\n  No token in .env yet. Put one there first.\n")
        return 1

    now = datetime.now(timezone.utc)
    age_min = (now - saved_at).total_seconds() / 60

    print(f"\n  Token saved {age_min:.0f} minutes ago "
          f"({saved_at:%H:%M} UTC).")

    ok, res = api("me", fields="username,account_type", access_token=token)
    if not ok:
        if res.get("error", {}).get("_transport"):
            print(f"  Could not reach the API: {err(res)}")
            print("  Network problem, not a token problem.\n")
            return 1
        print(f"  The token is NOT working: {err(res)}")
        print("\n  If it worked earlier and has now stopped, it was short-lived")
        print("  and the hour is up. Generate a fresh one and run:")
        print("      python3 token_tool.py exchange\n")
        return 1

    print(f"  Works right now  ->  @{res.get('username')} ({res.get('account_type')})")

    if age_min < 60:
        mins = 60 - age_min
        safe = datetime.fromtimestamp(saved_at.timestamp() + 3660, tz=timezone.utc)
        local = safe.astimezone()
        print("\n  INCONCLUSIVE. A short-lived token lasts an hour, so at this")
        print(f"  age both kinds look identical. Re-run in {mins:.0f} minutes")
        print(f"  (after {safe:%H:%M} UTC / {local:%H:%M} local). If it still")
        print("  works then, it is long-lived.\n")
        return 0

    print(f"\n  LONG-LIVED, confirmed. It has survived {age_min/60:.1f} hours,")
    print("  well past the one-hour life of a short-lived token.")
    print("  You do not need the exchange, and you never need your app secret.")

    if age_min > 24 * 60:
        print("\n  It is also over 24 hours old, so it can be refreshed now:")
        ok, res = api("refresh_access_token", grant_type="ig_refresh_token",
                      access_token=token)
        if ok:
            days = res.get("expires_in", 0) / 86400
            print(f"  Refreshed -- good for another {days:.0f} days.")
            write_token(res["access_token"])
            print("  Saved to .env.")
        else:
            print(f"  Refresh failed: {err(res)}")
    print()
    return 0


def cmd_exchange():
    print("\n  Short-lived -> long-lived exchange.")
    print("  Needs your INSTAGRAM app secret (not the Facebook one -- different")
    print("  value, similar label). Dashboard > Instagram > API setup with")
    print("  Instagram business login.\n")

    secret = getpass("  Instagram app secret (hidden): ").strip()
    if not secret:
        print("  Nothing entered.\n")
        return 1

    existing, _ = read_env_token()
    if existing:
        use = input("  Exchange the token already in .env? [Y/n]: ").strip().lower()
        token = existing if use in ("", "y", "yes") else getpass(
            "  Short-lived token (hidden): ").strip()
    else:
        token = getpass("  Short-lived token (hidden): ").strip()

    if not token:
        print("  Nothing entered.\n")
        return 1

    ok, res = api("access_token", grant_type="ig_exchange_token",
                  client_secret=secret, access_token=token)
    if not ok:
        print(f"\n  Exchange failed: {err(res)}")
        print("\n  Common causes, in order of likelihood:")
        print("   - the token is ALREADY long-lived (you cannot exchange twice)")
        print("   - the short-lived token's hour has expired")
        print("   - wrong secret: the Facebook app secret instead of the Instagram one\n")
        return 1

    days = res.get("expires_in", 0) / 86400
    print(f"\n  Success -- long-lived token, valid {days:.0f} days.")
    write_token(res["access_token"])
    print(f"  Written to {ENV.name} (permissions set to owner-only).")
    print("\n  Next: python3 probe.py    to confirm it works.\n")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        sys.exit(cmd_check())
    if cmd == "exchange":
        sys.exit(cmd_exchange())
    print(__doc__)
    sys.exit(1)
