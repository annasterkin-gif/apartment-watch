@echo off
echo Starting Apartment Watch...
start cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3456"
node apartment-config-ui.js
