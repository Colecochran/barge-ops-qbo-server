@echo off

echo Starting Node server...
start "Node Server" cmd /k "node server.js"

timeout /t 4 >nul

echo Starting ngrok tunnel...
start "ngrok" cmd /k "ngrok http 3000"

timeout /t 3 >nul

echo Opening dashboard...
start http://localhost:3000/dashboard

echo Done.