#!/bin/bash
set -e

echo "============================================================"
echo " 企业微信AI客服 - 一键安装依赖"
echo "============================================================"
echo

cd "$(dirname "$0")"

# 检查 Node.js
echo "[1/3] 检查 Node.js..."
if ! command -v node > /dev/null 2>&1; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js v18.13+ 或 v20.9+"
    echo "   Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs"
    echo "   CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs"
    exit 1
fi
echo "✅ Node.js $(node --version)"
echo

# 配置 npm 镜像源并安装依赖
echo "[2/3] 安装 Node.js 依赖..."
echo "配置 npm 镜像源 (npmmirror)..."
npm config set registry https://registry.npmmirror.com
npm install
if [ $? -ne 0 ]; then
    echo "❌ npm install 失败"
    exit 1
fi
echo "✅ 依赖安装完成"
echo

# 构建项目
echo "[3/3] 构建项目..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ 构建失败"
    exit 1
fi
echo "✅ 构建完成"
echo

echo "============================================================"
echo " 安装完成！"
echo " 请确认 .env 文件已配置，然后运行 ./start.sh 启动服务"
echo " 注意：需要先启动 wework-sdk-service（SDK服务）"
echo "============================================================"
