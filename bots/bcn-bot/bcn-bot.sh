#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
export NODE_OPTIONS="--disable-warning=ExperimentalWarning"
exec "../node_modules/.bin/tsx" "bcn-bot.ts"
