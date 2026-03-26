@echo off
chcp 65001 >nul 2>&1
title 企业微信AI客服 - 一键安装依赖

echo ============================================================
echo  企业微信AI客服 - 一键安装依赖
echo ============================================================
echo.

cd /d %~dp0

:: 检查 Node.js
echo [1/3] 检查 Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js v18.13+ 或 v20.9+
    echo    下载地址: https://nodejs.org/zh-cn/download
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo ✅ Node.js %%v
echo.

:: 配置 npm 镜像源并安装依赖
echo [2/3] 安装 Node.js 依赖...
echo 配置 npm 镜像源 (npmmirror)...
call npm config set registry https://registry.npmmirror.com
call npm install
if %errorlevel% neq 0 (
    echo ❌ npm install 失败
    pause
    exit /b 1
)
echo ✅ 依赖安装完成
echo.

:: 构建项目
echo [3/3] 构建项目...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ 构建失败
    pause
    exit /b 1
)
echo ✅ 构建完成
echo.

echo ============================================================
echo  安装完成！
echo  请确认 .env 文件已配置，然后运行 start.bat 启动服务
echo  注意：需要先启动 wework-sdk-service（SDK服务）
echo ============================================================
pause
