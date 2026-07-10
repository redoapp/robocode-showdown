@echo off
cd /d "%~dp0"
set NODE_OPTIONS=--disable-warning=ExperimentalWarning
..\node_modules\.bin\tsx javaroc-bot.ts
