@echo off
setlocal enabledelayedexpansion

echo ================================
echo Installing Node.js + ngrok setup
echo ================================

:: Create tools folder
set INSTALL_DIR=%USERPROFILE%\barge-tools
mkdir "%INSTALL_DIR%"
cd "%INSTALL_DIR%"

:: ----------------------------
:: 1. Download Node.js LTS
:: ----------------------------
echo Downloading Node.js LTS...

powershell -Command ^
Invoke-WebRequest https://nodejs.org/dist/v20.11.1/node-v20.11.1-x64.msi -OutFile node.msi

echo Installing Node.js...
msiexec /i node.msi /quiet /norestart

:: Wait for install
timeout /t 10 >nul

:: ----------------------------
:: 2. Verify Node install
:: ----------------------------
echo Checking Node.js version...
node -v
npm -v

:: ----------------------------
:: 3. Install ngrok
:: ----------------------------
echo Downloading ngrok...

powershell -Command ^
Invoke-WebRequest https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip -OutFile ngrok.zip

echo Extracting ngrok...
powershell -Command ^
Expand-Archive ngrok.zip -DestinationPath ngrok -Force

set NGROK=%INSTALL_DIR%\ngrok\ngrok.exe

:: ----------------------------
:: 4. Set ngrok authtoken (auto)
:: ----------------------------
echo Configuring ngrok...

set NGROK_TOKEN=3EagmbxqiRg3fjYXqJmay249Gxz_3DDb3zQ9QBCvkiRCGJyBY

%NGROK% config add-authtoken %NGROK_TOKEN%

:: ----------------------------
:: 5. Install Node dependencies
:: ----------------------------
echo Installing project dependencies...
cd /d "%~dp0"
npm install

:: ----------------------------
:: 6. Start everything
:: ----------------------------
echo Starting server...

start cmd /k "node server.js"

timeout /t 3 >nul

echo Starting ngrok tunnel...

start cmd /k "%NGROK% http 3000"

timeout /t 3 >nul

echo Opening dashboard...
start http://localhost:3000/dashboard

echo ================================
echo Setup complete
echo ================================
pause