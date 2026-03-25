@echo off
cd /d "C:\Users\Anna\realtor"

:: ── Paste your Zapier webhook URL below ──────────────────────────────────────
set ZAPIER_WEBHOOK_URL=https://hooks.zapier.com/hooks/catch/26666153/u0lam6p/

for /f "tokens=2 delims==" %%a in ('wmic os get localdatetime /value 2^>nul') do set DT=%%a
set LOGFILE=runlog-%DT:~0,8%-%DT:~8,6%.txt

node .\apartment-watch.js > "%LOGFILE%" 2>&1

:: Delete logs older than 7 days
forfiles /p "C:\Users\Anna\realtor" /m "runlog-????????-??????.txt" /d -7 /c "cmd /c del @path" 2>nul

exit /b %errorlevel%
