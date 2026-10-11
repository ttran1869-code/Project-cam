@echo off
REM AirSketch launcher - tries python first, falls back to node.
cd /d "%~dp0"

where python >nul 2>&1
if %ERRORLEVEL% == 0 (
    start "AirSketch server" cmd /k python -m http.server 8000
    goto open
)

where py >nul 2>&1
if %ERRORLEVEL% == 0 (
    start "AirSketch server" cmd /k py -3 -m http.server 8000
    goto open
)

where node >nul 2>&1
if %ERRORLEVEL% == 0 (
    start "AirSketch server" cmd /k npx --yes serve . -l 8000
    goto open
)

echo.
echo Could not find Python or Node.js on PATH.
echo Install one of them and try again.
pause
exit /b 1

:open
timeout /t 2 /nobreak >nul
start http://localhost:8000
echo.
echo AirSketch is running at http://localhost:8000
echo Close the server window to stop.
