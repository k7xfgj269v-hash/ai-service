@echo off
chcp 65001 >nul 2>&1
title 企业微信AI客服 - 一键启动

echo ============================================================
echo  企业微信AI客服 - 一键启动
echo ============================================================
echo.

cd /d %~dp0

:: 构建 Node.js 项目
echo [1/2] 构建 Node.js 项目...
call npm run build
if %errorlevel% neq 0 (
    echo ❌ Node.js 构建失败
    pause
    exit /b 1
)
echo ✅ 构建完成
echo.

:: 启动 Node.js 服务
echo [2/2] 启动 Node.js 服务...
echo   - 主服务: http://localhost:3031
echo   - API文档: http://localhost:3031/api
echo   - 专区回调接口: http://localhost:3031/spec-callback/*
echo ============================================================
echo  服务启动中... 按 Ctrl+C 停止
echo ============================================================
echo.
call npm run start:prod
