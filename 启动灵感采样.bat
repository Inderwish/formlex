@echo off
chcp 65001 >nul
title 形意词库 - FormLex
cd /d "%~dp0"
if errorlevel 1 goto missing_project
if not exist "server.mjs" goto missing_project
where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
echo 正在启动形意词库，服务就绪后会自动打开浏览器。
echo 请保留此窗口；关闭窗口即可停止服务。
echo.
node.exe server.mjs --port 3000 --open
if errorlevel 1 goto failed
echo DONE
exit /b 0

:missing_project
echo 找不到项目，请确认项目文件夹未被移动或删除。
goto failed

:missing_node
echo 找不到 Node.js，请安装 Node.js 22 或更新版本。
goto failed

:failed
echo.
echo 启动未成功，请查看上方原因。如果已经启动过，请使用原来的服务窗口。
pause
exit /b 1
