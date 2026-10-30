@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title MITRA - Direct Setup

echo.
echo ==================================================
echo              MITRA DIRECT SETUP
echo ==================================================
echo.
echo This script installs MITRA's Node.js packages.
echo An internet connection is required during setup.
echo.

REM Check Node.js
where node >nul 2>nul
if errorlevel 1 goto no_node

REM Check npm
where npm >nul 2>nul
if errorlevel 1 goto no_npm

REM Require Node.js 20 or newer
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if errorlevel 1 goto old_node

echo [OK] Node.js:
node -v
echo [OK] npm:
call npm -v
echo.

REM Make sure the script is being run in the MITRA project folder
if not exist "server.js" if not exist "app.js" if not exist "index.js" if not exist "package.json" (
    echo [WARNING] No common application entry file or package.json was found.
    echo This script will still install the listed packages in this folder.
    echo Make sure this is the correct MITRA project directory.
    echo.
)

REM Create package.json if this folder does not have one
if exist "package.json" goto install_packages

echo [1/4] Creating package.json...
call npm init -y
if errorlevel 1 goto failed

:install_packages
echo.
echo [2/4] Installing MITRA runtime dependencies...
echo This may take several minutes.
echo.

call npm install express helmet multer better-sqlite3 dotenv pdfjs-dist mammoth sanitize-html adm-zip tesseract.js @fontsource/inter @fontsource/noto-sans-tamil lucide-static
if errorlevel 1 goto failed

echo.
echo [OK] Packages installed.
echo.

REM Create .env only if an example file exists and .env is missing
echo [3/4] Preparing environment settings...
if exist ".env" (
    echo [OK] Existing .env file found. It will not be overwritten.
)

if exist ".env.example" (
    copy ".env.example" ".env" >nul
    if errorlevel 1 goto env_failed
    echo [OK] Created .env from .env.example.
    echo Review .env and enter any required settings.
    goto success

) else (
    echo [INFO] .env.example was not found; no .env file was created.
    goto failed
)


:success
echo.
echo ==================================================
echo             MITRA SETUP COMPLETED
echo ==================================================
echo.
echo Dependencies have been installed in:
echo %CD%
echo.
echo Next:
echo 1. Review your .env settings, if applicable.
echo 2. Start MITRA using its configured start command,
echo    for example: npm start
echo.
echo Note: npm install does not create a Windows installer
echo or desktop shortcut. Online AI needs internet access.
echo OCR language data may download the first time OCR is used.
echo.
pause
exit /b 0

:no_node
echo.
echo [ERROR] Node.js was not found.
echo Install Node.js LTS version 20 or newer from:
echo https://nodejs.org/
echo Then close and reopen the terminal and run setup.bat again.
goto error_exit

:no_npm
echo.
echo [ERROR] npm was not found.
echo Reinstall Node.js LTS from https://nodejs.org/
echo using the default installer options.
goto error_exit

:old_node
echo.
echo [ERROR] MITRA requires Node.js version 20 or newer.
echo Install a supported Node.js LTS version from:
echo https://nodejs.org/
goto error_exit

:env_failed
echo.
echo [ERROR] Could not create .env from .env.example.
echo Check folder permissions and try again.
goto error_exit

:failed
echo.
echo ==================================================
echo                 SETUP FAILED
echo ==================================================
echo.
echo Read the npm error messages above.
echo Check your internet connection and Node.js version.
echo If better-sqlite3 fails, check Node.js/package compatibility
echo and the native build requirements for your Windows system.
echo Then fix the reported issue and run setup.bat again.
goto error_exit

:error_exit
echo.
pause
exit /b 1
