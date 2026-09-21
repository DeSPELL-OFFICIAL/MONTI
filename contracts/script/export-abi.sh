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

# CoinbaseSmartWalletFactory is compiled out of lib/smart-wallet rather than src/, but forge lays
# every artifact out the same way, so it needs no special case here. Sub-plan 03 creates accounts
# through it, which is why it travels with the four MONTI contracts.
for name in Identity Organizers Ticket MontiPaymaster CoinbaseSmartWalletFactory; do
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
