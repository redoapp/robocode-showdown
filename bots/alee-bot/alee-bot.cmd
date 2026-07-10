@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
node --experimental-strip-types alee-bot.ts
