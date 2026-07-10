#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
exec "../.venv/bin/python" -u "ndriggs-bot.py"
