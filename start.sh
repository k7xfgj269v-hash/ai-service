#!/bin/bash
set -e

echo "============================================================"
echo " 企业微信AI客服 - 一键启动"
echo "============================================================"
echo

cd "$(dirname "$0")"

# 构建 Node.js 项目
echo "[1/2] 构建 Node.js 项目..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Node.js 构建失败"
    exit 1
fi
echo "✅ 构建完成"
echo

# 启动 Node.js 服务
echo "[2/2] 启动 Node.js 服务..."
echo "  - 主服务: http://localhost:3031"
echo "  - API文档: http://localhost:3031/api"
echo "  - 专区回调接口: http://localhost:3031/spec-callback/*"
echo "============================================================"
echo " 服务启动中... 按 Ctrl+C 停止"
echo "============================================================"
echo
npm run start:prod
