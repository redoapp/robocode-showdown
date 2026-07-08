#!/bin/sh
set -e
cd -- "$(dirname -- "$0")"
exec "../.venv/bin/python" -u "SamplePyBot.py"
