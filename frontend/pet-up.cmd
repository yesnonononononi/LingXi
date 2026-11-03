@echo off
rem ===========================================================================
rem LX desktop pet launcher - THIN ENTRY SHELL ONLY (version controlled).
rem
rem All logic lives in the repository now:
rem   scripts\pet-dev-server.cjs   -> probe + lock + start the pet dev server
rem   electron\pet-launcher.cjs    -> probe + pet window + tray + single instance
rem   electron\pet-dev-endpoint.cjs-> the ONLY source of port / entry page
rem
rem This file deliberately contains NO port number, NO path, NO lock logic:
rem the old out-of-repo pet-up.cmd had all three, so "new machine / another
rem worktree" broke it and CI could not see it.
rem
rem ASCII only on purpose: cmd.exe parses .cmd with the OEM codepage, so UTF-8
rem Chinese comments get split into bogus commands. Chinese text is printed by
rem the node/electron side.
rem
rem Usage: double-click, or run pet-up.cmd from a shell. Add -y to skip the
rem final pause (used by automated checks).
rem ===========================================================================
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

call npm run pet:dev
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo [ABORT] pet dev chain failed ^(exit %RC%^): the pet window was NOT opened.
  echo         See the message above - "not the pet service" vs "no service"
  echo         are different failures and the log says which one it is.
)

if /i "%~1"=="-y" exit /b %RC%
pause
exit /b %RC%
