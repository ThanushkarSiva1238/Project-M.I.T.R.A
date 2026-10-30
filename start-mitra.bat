@echo off
setlocal
cd /d "%~dp0"
title MITRA (keep this window open)
where node >nul 2>nul
if errorlevel 1 (echo Node.js not found. Install it from https://nodejs.org and restart the computer. & pause & exit /b 1)
if not exist node_modules (echo Packages are missing. Please run setup.bat first. & pause & exit /b 1)
if not exist .env if exist .env.example copy .env.example .env >nul
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"PORT=" .env') do set MPORT=%%p
if "%MPORT%"=="" set MPORT=3000
echo Starting MITRA on http://127.0.0.1:%MPORT% ...
start "" cmd /c "timeout /t 4 /nobreak >nul & start http://127.0.0.1:%MPORT%"
node server.js
echo.
echo MITRA stopped. If you see an error above, please copy it. (EADDRINUSE = port already in use: close other MITRA windows or change PORT in .env)
pause
