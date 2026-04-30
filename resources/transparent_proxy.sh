#!/bin/bash
# ContextGate Transparent Proxy Setup Script
# This script sets up system-level proxy to automatically route API requests through ContextGate

PROXY_PORT=${1:-12306}
TARGET_HOST="api.openai.com"
TARGET_PORT=443

case "$1" in
  install)
    echo "[ContextGate] Setting up transparent proxy..."
    echo "127.0.0.1 api.openai.com" >> /etc/hosts
    echo "Created /etc/hosts entry: 127.0.0.1 api.openai.com"
    echo "Please restart your browser/IDE for changes to take effect."
    ;;
  uninstall)
    echo "[ContextGate] Removing transparent proxy..."
    sed -i '/api.openai.com/d' /etc/hosts
    echo "Removed /etc/hosts entry for api.openai.com"
    ;;
  status)
    if grep -q "api.openai.com" /etc/hosts 2>/dev/null; then
      echo "[ContextGate] Transparent proxy: ACTIVE"
    else
      echo "[ContextGate] Transparent proxy: INACTIVE"
    fi
    ;;
  *) echo "Usage: $0 {install|uninstall|status}"; exit 1;;
esac