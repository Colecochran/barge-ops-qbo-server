@echo off

echo Starting server...

start cmd /k "node server.js"

timeout /t 3 >nul

echo Starting ngrok tunnel...

start cmd /k "NGROk http 3000"

timeout /t 3 >nul

echo Opening dashboard...
start http://localhost:3000/dashboard

echo Done.