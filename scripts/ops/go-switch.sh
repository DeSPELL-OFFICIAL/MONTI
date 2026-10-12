#!/bin/bash
# MONTI v1 <-> v2 production switch (O8 GO / rollback). bash 3.2 compatible (no assoc arrays).
#   go-switch.sh go <ENVIO_V2_ID>   : stored Production env -> v2 values, vercel --prod from MONTI-web (v2/web), schedulers v1->v2
#   go-switch.sh rollback           : alias back to the v1 deployment, env -> v1 values, schedulers v2->v1
#   go-switch.sh status             : live bundle + scheduler states
# Never prints tokens or .secrets contents.
set -euo pipefail
WEB=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/MONTI-web
SEC=/Users/moomi/Downloads/z03.Vibe_Coding/MONTI/.secrets
AUTH="$HOME/Library/Application Support/com.vercel.cli/auth.json"
API=https://api.vercel.com
SLUG=despells-projects
V1_DEPLOY=https://monti-93g8r25jw-despells-projects.vercel.app
V1_TICKET=7E1fdfCB3688C5b0539101cEAE6a7Ee5bD9b51Cf
V2_TICKET=8544c531A3EF7f702fe3A64Ff20D57bA774d9edC
SCHED=https://cloudscheduler.googleapis.com/v1/projects/mon-ti/locations
JOBS="reconcilePending dailyExport processDeletions closeEndedChats"
KEYS="VITE_ADDR_IDENTITY VITE_ADDR_ORGANIZERS VITE_ADDR_TICKET VITE_ADDR_FORWARDER VITE_ADDR_SETTLEMENT_VAULT VITE_FUNCTIONS_REGION VITE_ENVIO_URL"
ENVIO_V2_URL=""

env_id() {
  case "$1" in
    VITE_ADDR_IDENTITY) echo 8lcgvJ2OeOvC0bl5 ;;
    VITE_ADDR_ORGANIZERS) echo Vi8YY6Udvn1DRxYu ;;
    VITE_ADDR_TICKET) echo ZFCV2lNIZvSd8yMj ;;
    VITE_ADDR_FORWARDER) echo gxQyJzajx3qdh6tc ;;
    VITE_ADDR_SETTLEMENT_VAULT) echo DbZCd9aijUY9yunT ;;
    VITE_FUNCTIONS_REGION) echo G7xKiOAmyM6hz2eJ ;;
    VITE_ENVIO_URL) echo 0KlPQBDqnaimKCAm ;;
    *) echo "unknown key $1" >&2; return 1 ;;
  esac
}
v2_value() {
  case "$1" in
    VITE_ADDR_IDENTITY) echo 0x1EDFE1BC63e4239e8fB1c62249a33B78BAFC4B27 ;;
    VITE_ADDR_ORGANIZERS) echo 0x18134b640912A6f54e83B30DD079039627173dca ;;
    VITE_ADDR_TICKET) echo 0x8544c531A3EF7f702fe3A64Ff20D57bA774d9edC ;;
    VITE_ADDR_FORWARDER) echo 0xcE6DC3040A500545604d0Bb6c594493d4Bd1ddbb ;;
    VITE_ADDR_SETTLEMENT_VAULT) echo 0xDC3DDd274bb22a112ba8A120De471037aeE52925 ;;
    VITE_FUNCTIONS_REGION) echo us-east4 ;;
    VITE_ENVIO_URL) echo "$ENVIO_V2_URL" ;;
  esac
}
v1_value() { # from the .secrets backup; never echoed by callers
  grep -E "^$1=" "$SEC/vercel-production-v1.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

vtoken() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["token"])' "$AUTH"; }
gtoken() { GOOGLE_APPLICATION_CREDENTIALS="$SEC/monti-deployer.json" gcloud auth application-default print-access-token 2>/dev/null; }

patch_env() { # key value quiet?
  local key=$1 val=$2 quiet=${3:-} tok; tok=$(vtoken)
  local out; out=$(curl -s -X PATCH -H "Authorization: Bearer $tok" -H 'content-type: application/json' \
    "$API/v9/projects/monti/env/$(env_id "$key")?slug=$SLUG" -d "{\"value\":\"$val\"}")
  if [ -n "$quiet" ]; then
    printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  env", d.get("key") or d, "patched" if d.get("key") else "")'
  else
    printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  env", d.get("key"), "->", (d.get("value") or str(d))[:60], d.get("target"))'
  fi
}
verify_env() { # mode v1|v2 ; compares stored values with expected; prints OK/BAD (v1 values masked)
  local mode=$1 tok k exp; tok=$(vtoken)
  local tmp; tmp=$(mktemp)
  curl -s -H "Authorization: Bearer $tok" "$API/v9/projects/monti/env?slug=$SLUG" > "$tmp"
  local bad=0
  for k in $KEYS; do
    if [ "$mode" = v2 ]; then exp=$(v2_value "$k"); else exp=$(v1_value "$k"); fi
    local cur; cur=$(python3 -c 'import sys,json; d=json.load(open(sys.argv[1])); print(next((e.get("value","") for e in d.get("envs",[]) if e["id"]==sys.argv[2]), ""))' "$tmp" "$(env_id "$k")")
    if [ "$cur" = "$exp" ]; then
      if [ "$mode" = v2 ]; then echo "   OK  $k = ${cur:0:48}"; else echo "   OK  $k (v1 value)"; fi
    else
      bad=$((bad+1)); echo "   BAD $k (stored ${cur:0:12}…, expected ${exp:0:12}…)"
    fi
  done
  rm -f "$tmp"; [ "$bad" -eq 0 ]
}
sched() { # action(pause|resume) location
  local action=$1 loc=$2 tok j; tok=$(gtoken)
  for j in $JOBS; do
    curl -s -X POST -H "Authorization: Bearer $tok" "$SCHED/$loc/jobs/firebase-schedule-$j-$loc:$action" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print("  sched", d.get("name","?").split("/")[-1], d.get("state") or d.get("error",{}).get("message"))'
  done
}
bundle() {
  local html entry js
  html=$(curl -s -m 20 https://monti.despell.io/); entry=$(printf '%s' "$html" | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
  js=$(curl -s -m 30 "https://monti.despell.io$entry")
  printf '  bundle %s  v1Ticket=%s v2Ticket=%s us-east1=%s us-east4=%s envio=%s\n' "$entry" \
    "$(printf '%s' "$js" | grep -oi "$V1_TICKET" | wc -l | tr -d ' ')" "$(printf '%s' "$js" | grep -oi "$V2_TICKET" | wc -l | tr -d ' ')" \
    "$(printf '%s' "$js" | grep -o us-east1 | wc -l | tr -d ' ')" "$(printf '%s' "$js" | grep -o us-east4 | wc -l | tr -d ' ')" \
    "$(printf '%s' "$js" | grep -oE 'hyperindex\.xyz/[a-f0-9]+' | sort -u | tr '\n' ' ')"
}
status() {
  echo "== live bundle"; bundle
  local tok loc; tok=$(gtoken)
  for loc in us-east1 us-east4; do echo "== scheduler $loc"; curl -s -H "Authorization: Bearer $tok" "$SCHED/$loc/jobs" | python3 -c 'import sys,json; [print("  ", j["name"].split("/")[-1], j.get("state")) for j in json.load(sys.stdin).get("jobs",[])]'; done
}

case "${1:-}" in
  go)
    ENVIO_ID=${2:?usage: go <ENVIO_V2_ID>}
    ENVIO_V2_URL="https://indexer.dev.hyperindex.xyz/$ENVIO_ID/v1/graphql"
    echo "== indexer check"; curl -s -m 15 -X POST -H 'content-type: application/json' --data '{"query":"{ chain_metadata { chain_id is_hyper_sync latest_processed_block } }"}' "$ENVIO_V2_URL"; echo
    echo "== PATCH production env -> v2"; for k in $KEYS; do patch_env "$k" "$(v2_value "$k")"; done
    echo "== verify"; verify_env v2
    echo "== deploy v2/web --prod"; ( cd "$WEB" && git log --oneline -1 )
    DEPLOY_URL=$( cd "$WEB" && fnm exec --using=22 vercel --prod --scope "$SLUG" --yes 2>/dev/null | tail -1 )
    echo "  deployment: $DEPLOY_URL"
    # After a `vercel rollback`, new production deployments are NOT assigned to the custom domain
    # automatically (observed 2026-10-12: deploy aliased only monti-despells-projects.vercel.app).
    # `vercel promote` pins the domain to this deployment.
    echo "== promote to monti.despell.io"; ( cd "$WEB" && fnm exec --using=22 vercel promote "$DEPLOY_URL" --scope "$SLUG" --yes 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -E 'Success|Error' )
    sleep 8; echo "== live bundle"; bundle
    echo "== schedulers v1 pause / v2 resume"; sched pause us-east1; sched resume us-east4
    ;;
  rollback)
    echo "== alias back to v1 deployment"; ( cd "$WEB" && fnm exec --using=22 vercel rollback "$V1_DEPLOY" --scope "$SLUG" --yes 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -E 'Success|Error' )
    echo "== PATCH production env -> v1 (from .secrets backup, values not printed)"; for k in $KEYS; do patch_env "$k" "$(v1_value "$k")" quiet; done
    echo "== verify"; verify_env v1
    sleep 5; echo "== live bundle"; bundle
    echo "== schedulers v2 pause / v1 resume"; sched pause us-east4; sched resume us-east1
    ;;
  status) status ;;
  *) echo "usage: $0 go <ENVIO_V2_ID> | rollback | status"; exit 2 ;;
esac
