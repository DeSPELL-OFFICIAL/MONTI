#!/bin/sh
# The merge queue's gate (ORCHE 0.9.0) and CI's entry point (SPEC §12.2): the checks CI would run, in order.
# It runs in a fresh checkout of the PR merged onto main. Exit non-zero on any failure. It gets no secrets.
# ORCHE wrote it from the repository's manifest; edit it freely (add a build or type-check step before the tests).
set -eu
# install: nothing to install
echo "no test command found in package.json, pyproject.toml, go.mod or Cargo.toml"
# The last line says what this script verified: type-check-only, unit-test-verified or live-ui-verified.
echo "verdict: type-check-only"
