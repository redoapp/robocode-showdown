#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
exec node --experimental-strip-types "unbeaten-kimchi.ts"
