@echo off
cd /d "%~dp0"
echo Building Sentinel Vector - StockWatcher...
call npm run build > build.log 2>&1
echo Exit code %ERRORLEVEL% >> build.log
type build.log
echo.
echo Done. Installer: dist\SentinelVector-StockWatcher-Setup-*.exe  (run it to install)
echo This window can be closed.
pause
