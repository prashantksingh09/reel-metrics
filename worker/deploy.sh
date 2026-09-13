#!/usr/bin/env bash
# Deploy the reel-metrics Worker to Cloudflare.
#
# Safe to re-run: every step checks whether it has already been done.
# Secrets are piped, never echoed and never passed as arguments, so nothing
# lands in your shell history.
#
#   ./deploy.sh
#
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE="../phase0/.env"
INFO_FILE=".deploy-info"
DB_NAME="reel-metrics"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m    %s\n" "$1"; }
warn() { printf "  \033[33mnote\033[0m  %s\n" "$1"; }
die()  { printf "\n  \033[31mstopped\033[0m  %s\n\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
bold "1/6  Checking prerequisites"

command -v node >/dev/null || die "node is not installed."
ok "node $(node --version)"

if ! command -v wrangler >/dev/null; then
  warn "wrangler is not installed."
  read -r -p "  Install it globally now (npm install -g wrangler)? [Y/n]: " a
  case "${a:-y}" in
    [Yy]*|"") npm install -g wrangler ;;
    *) die "wrangler is required. Install it, then re-run this script." ;;
  esac
fi
ok "wrangler $(wrangler --version 2>&1 | head -1)"

if ! wrangler whoami >/dev/null 2>&1; then
  die "Not logged in to Cloudflare. Run:  wrangler login   then re-run this script."
fi
ok "logged in to Cloudflare"

[ -f "$ENV_FILE" ] || die "No $ENV_FILE. That is where the Instagram token lives."
IG_TOKEN="$(grep -E '^IG_ACCESS_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"' " || true)"
[ -n "$IG_TOKEN" ] && [[ "$IG_TOKEN" != paste_* ]] \
  || die "No real token in $ENV_FILE. Run phase0/token_tool.py check first."
ok "Instagram token found (${#IG_TOKEN} characters)"

# ------------------------------------------------------------------ database
bold "2/6  D1 database"

CURRENT_ID="$(grep -E '^database_id' wrangler.toml | cut -d'"' -f2)"
if [[ "$CURRENT_ID" == PASTE_* || -z "$CURRENT_ID" ]]; then
  # Either create it, or adopt one that already exists under this name.
  if wrangler d1 list --json 2>/dev/null | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const l=JSON.parse(s||"[]");
        const m=l.find(d=>d.name===process.argv[1]);
        if(m){console.log(m.uuid);process.exit(0)}process.exit(1)})' "$DB_NAME" > /tmp/_d1id 2>/dev/null; then
    DB_ID="$(cat /tmp/_d1id)"
    warn "a database named $DB_NAME already exists; reusing it"
  else
    wrangler d1 create "$DB_NAME" | tee /tmp/_d1out
    DB_ID="$(grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' /tmp/_d1out | head -1)"
    rm -f /tmp/_d1out
  fi
  [ -n "$DB_ID" ] || die "Could not determine the database id. Create it manually with: wrangler d1 create $DB_NAME"
  # Patch wrangler.toml rather than making you copy a UUID by hand.
  node -e '
    const fs=require("fs");
    const p="wrangler.toml";
    fs.writeFileSync(p, fs.readFileSync(p,"utf8")
      .replace(/database_id = ".*"/, `database_id = "${process.argv[1]}"`));
  ' "$DB_ID"
  rm -f /tmp/_d1id
  ok "database ready, id written into wrangler.toml"
else
  ok "wrangler.toml already points at a database"
fi

# -------------------------------------------------------------------- schema
bold "3/6  Applying the schema"
warn "this runs against the REMOTE database (--remote). Answer yes if prompted."
wrangler d1 execute "$DB_NAME" --remote --file=schema.sql
ok "tables created"

# ------------------------------------------------------------------- secrets
bold "4/6  Secrets"

if [ -f "$INFO_FILE" ] && grep -q '^API_KEY=' "$INFO_FILE"; then
  API_KEY="$(grep '^API_KEY=' "$INFO_FILE" | cut -d= -f2-)"
  ok "reusing the existing API key from $INFO_FILE"
else
  API_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
  ok "generated a new API key"
fi

printf '%s' "$IG_TOKEN" | wrangler secret put IG_ACCESS_TOKEN >/dev/null
ok "IG_ACCESS_TOKEN set"
printf '%s' "$API_KEY" | wrangler secret put API_KEY >/dev/null
ok "API_KEY set"

# -------------------------------------------------------------------- deploy
bold "5/6  Deploying"
wrangler deploy | tee /tmp/_dep
URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' /tmp/_dep | head -1)"

# The cron is the whole point, and a deploy that uploads the code but fails to
# register the trigger looks completely successful. Catch it here rather than
# an hour later when no data has arrived.
if grep -qiE 'schedule|cron' /tmp/_dep; then
  ok "cron trigger registered: $(grep -iE 'schedule|cron' /tmp/_dep | head -1 | sed 's/^ *//')"
else
  warn "NO CRON TRIGGER in the deploy output."
  warn "The Worker will answer requests but will never collect anything on its own."
  warn "Check [triggers] in wrangler.toml, then look at:"
  warn "  Cloudflare dashboard > Workers & Pages > reel-metrics > Settings > Triggers"
fi
rm -f /tmp/_dep
[ -n "$URL" ] || die "Deployed, but could not read the URL from the output. Check the Cloudflare dashboard."

{ echo "URL=$URL"; echo "API_KEY=$API_KEY"; } > "$INFO_FILE"
chmod 600 "$INFO_FILE"
ok "live at $URL"

# -------------------------------------------------------------------- verify
bold "6/6  Verifying"

echo "  health:"
curl -fsS "$URL/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const h=JSON.parse(s);
  if(h.ok===false){console.log("    NOT READY:",h.error);console.log("    fix:",h.hint);process.exit(1)}
  console.log("    schema",h.schema,"| token stored:",h.token_stored,"| polled yet:",h.polled_yet);
})'

echo "  forcing a first poll (this talks to Instagram):"
curl -fsS -X POST "$URL/poll?key=$API_KEY&scope=all" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r=JSON.parse(s);
  if(!r.ok){console.log("    FAILED:",r.note||JSON.stringify(r));process.exit(1)}
  console.log("    ok —",r.changed,"values stored across",r.polled,"reels");
})'

echo "  summary:"
curl -fsS "$URL/summary?key=$API_KEY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const b=JSON.parse(s);
  if(b.error){console.log("    ",b.error);process.exit(1)}
  const L=b.latest;
  console.log("    @"+b.account.username, "| reels tracked:", b.reels.length);
  console.log("    latest:", Math.round(L.metrics.views), "views,",
              Math.round(L.metrics.likes), "likes,", L.age_hours+"h old");
  console.log("    token days left:", b.health.token_days_left);
  console.log("    deltas are null for now — that is correct until history builds");
})'

bold "Done"
cat <<EOF
  Worker:  $URL
  Key and URL saved to worker/$INFO_FILE (chmod 600, gitignored)

  Useful later:
    curl "\$(grep ^URL= $INFO_FILE | cut -d= -f2-)/summary?key=\$(grep ^API_KEY= $INFO_FILE | cut -d= -f2-)"

  It now polls every 15 minutes on its own. Come back in a day and the
  deltas will have filled in.
EOF
