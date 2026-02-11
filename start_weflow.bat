@echo off
chcp 65001 >nul
echo 正在启动 Weflow API CLI...

cd /d "%~dp0"

npm start

pause
