#!/usr/bin/env bash
# Every check this sub-plan calls "done", in one command. Sub-plan 02 wires the same steps into CI;
# run it here before every contracts commit.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "== fmt =="
forge fmt --check

echo "== build =="
# Not --sizes: forge 1.5.1 ignores code_size_limit there and exits 1 past EIP-170's 24,576 B,
# which is not the limit this chain has. test/ContractSize.t.sol holds Monad's 128 KB instead,
# and `forge test` below runs it.
forge build

echo "== test =="
forge test -vv

echo "== abi export =="
./script/export-abi.sh

echo "== abi snapshot is fresh =="
# The exported ABIs are committed, so a re-export that changes a file means an interface moved
# without the snapshot following it -- which sub-plans 02, 03 and 04 would only discover at runtime.
if git -C .. rev-parse --git-dir >/dev/null 2>&1; then
  stale="$(git -C .. status --porcelain -- packages/shared/src/abi)"
  if [ -n "$stale" ]; then
    echo "stale ABI snapshot -- commit the re-export:" >&2
    echo "$stale" >&2
    exit 1
  fi
  echo "packages/shared/src/abi is up to date"
else
  echo "not a git checkout -- skipping the freshness check"
fi

echo "all checks passed"
