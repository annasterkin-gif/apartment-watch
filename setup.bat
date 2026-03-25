@echo off
echo === Apartment Watch — Setup ===
echo.

:: Check for Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo Node.js not found. Installing via winget...
    winget install OpenJS.NodeJS.LTS --silent
    echo.
    echo Node.js installed. Please close this window and run setup.bat again.
    pause
    exit /b
) else (
    for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v found.
)

:: Install npm dependencies
echo.
echo Installing npm packages...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed. Check your internet connection and try again.
    pause
    exit /b
)
echo [OK] npm packages installed.

:: Install Playwright Chromium browser
echo.
echo Installing Playwright browser (~280 MB, please wait)...
call npx playwright install chromium
if errorlevel 1 (
    echo ERROR: Playwright browser install failed.
    pause
    exit /b
)
echo [OK] Playwright browser installed.

echo.
echo ============================================
echo  Setup complete!
echo  Run start.bat whenever you want to search.
echo ============================================
pause
