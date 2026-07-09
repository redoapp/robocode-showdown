@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
..\node_modules\.bin\tsx optimus2-0-bot.ts
