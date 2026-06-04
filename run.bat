@echo off

echo Starting Node server...
start "Node Server" cmd /k "node server.js"

echo Opening dashboard...
start http://localhost:3000/dashboard

echo Done.