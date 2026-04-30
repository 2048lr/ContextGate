#!/bin/bash

PROXY_PORT=12306
PROXY_HOST="127.0.0.1"

HOSTS_FILE="/etc/hosts"
BACKUP_FILE="/etc/hosts.contextgate.bak"

DOMAINS=(
  "api.openai.com"
  "api.anthropic.com"
  "api.cohere.ai"
  "api.mistral.ai"
  "openrouter.ai"
  "api.zhipuai.cn"
  "open.bigmodel.cn"
  "api.kourichat.com"
  "api.minimax.com"
)

check_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "Error: This script requires root privileges."
    echo "Please run with: sudo $0"
    exit 1
  fi
}

backup_hosts() {
  if [[ ! -f "$BACKUP_FILE" ]]; then
    cp "$HOSTS_FILE" "$BACKUP_FILE"
    echo "Backup saved to $BACKUP_FILE"
  fi
}

enable_proxy() {
  check_root
  backup_hosts

  echo "Enabling transparent proxy..."
  echo ""

  for domain in "${DOMAINS[@]}"; do
    if ! grep -q "^$PROXY_HOST.*$domain" "$HOSTS_FILE"; then
      echo "$PROXY_HOST $domain" >> "$HOSTS_FILE"
      echo "  -> $domain"
    else
      echo "  (already configured) $domain"
    fi
  done

  echo ""
  echo "Transparent proxy enabled!"
  echo "Proxy will listen on port $PROXY_PORT"
  echo ""
  echo "To start ContextGate proxy:"
  echo "  node cli.js serve --port $PROXY_PORT"
  echo ""
  echo "To disable, run: sudo $0 disable"
}

disable_proxy() {
  check_root

  echo "Disabling transparent proxy..."

  for domain in "${DOMAINS[@]}"; do
    sed -i "/^$PROXY_HOST.*$domain/d" "$HOSTS_FILE"
    echo "  <- $domain"
  done

  echo ""
  echo "Transparent proxy disabled!"
  echo "Hosts file restored to default"
}

status_proxy() {
  echo "ContextGate Transparent Proxy Status:"
  echo "================================"
  echo ""
  echo "Active domain mappings:"
  for domain in "${DOMAINS[@]}"; do
    if grep -q "^$PROXY_HOST.*$domain" "$HOSTS_FILE"; then
      echo "  [ON]  $domain"
    else
      echo "  [OFF] $domain"
    fi
  done
  echo ""
  echo "Proxy port: $PROXY_PORT"
  echo "Backup file: $BACKUP_FILE"
}

case "${1:-enable}" in
  enable)
    enable_proxy
    ;;
  disable)
    disable_proxy
    ;;
  status)
    status_proxy
    ;;
  restart)
    disable_proxy
    enable_proxy
    ;;
  *)
    echo "Usage: $0 {enable|disable|status|restart}"
    exit 1
    ;;
esac