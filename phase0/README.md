# Phase 0 — prove the data exists before building on it

Two scripts, standard library only, nothing to install.

## `token_tool.py`

```bash
python3 token_tool.py check      # what kind of token do I have?
python3 token_tool.py exchange   # short-lived -> 60 days
```

A short-lived Instagram token (1 hour) and a long-lived one (60 days) look
identical and behave identically until the short one dies. The only observable
difference is time, which is what `check` measures.

You probably don't need `exchange`: tokens generated from the **App Dashboard**
are already long-lived. It's the OAuth *flow* that hands out the one-hour kind.

Secrets are typed at a hidden prompt, never passed as arguments — an app secret
in a shell command lands in your history file permanently.

## `probe.py`

```bash
cp .env.example .env    # paste your token in
python3 probe.py
```

Asks Meta for a metric that cannot exist. The error lists every metric that
*does*, and the script then tests each one individually against a real reel.

This matters more than it sounds. Meta's own insights guide still shows
`impressions` in its examples more than a year after retiring it. The only
trustworthy answer to "which metrics exist" is the one your account gives, and
the answer differs between a fresh reel and an old one.

Writes a timestamped JSON dump of everything it found. That dump contains your
account's real numbers — it's gitignored, and should stay that way.
