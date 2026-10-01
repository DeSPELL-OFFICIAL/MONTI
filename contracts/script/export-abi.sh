#!/usr/bin/env bash
# Copies the contract ABIs into packages/shared so the web app, the Functions and the indexer all read
# the same file. Run after every forge build that changes a public interface.
#
# Each file holds the ABI array alone -- no `{abi: …}` wrapper -- because that is what viem's
# `getContract` and Envio's handlers take as is. `jq '.abi'` keeps forge's own key order, so a rerun
# that changed nothing rewrites the files byte for byte.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/../packages/shared/src/abi"

command -v jq >/dev/null || {
  echo "jq is required: brew install jq" >&2
  exit 1
}
command -v forge >/dev/null || {
  echo "forge is required: https://getfoundry.sh" >&2
  exit 1
}

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

cd "$ROOT"
forge build --silent

# The first-party contracts. MontiForwarder is the ERC-2771 relay the web app and Functions sign
# forward requests against; SettlementVault is the programmable-settlement layer (plan 2026-10-01) the
# web app, Functions and indexer read policy/escrow/ledger events from.
for name in Identity Organizers Ticket MontiForwarder SettlementVault; do
  src="$ROOT/out/$name.sol/$name.json"
  [ -f "$src" ] || {
    echo "missing $src -- run forge build" >&2
    exit 1
  }
  # Validate before writing: a half-written or wrong-shaped artifact (a stale `out/` from an aborted
  # build, a name that resolved to something that is not a contract) would otherwise land in
  # packages/shared as `null` and only fail inside viem at runtime.
  jq -e '(.abi | type) == "array" and (.abi | length) > 0' "$src" >/dev/null || {
    echo "malformed artifact: $src has no non-empty .abi array -- run forge build --force" >&2
    exit 1
  }
  jq '.abi' "$src" >"$OUT/$name.json"
  entries=$(jq 'length' "$OUT/$name.json")
  echo "$name -> $OUT/$name.json ($entries entries)"
done
