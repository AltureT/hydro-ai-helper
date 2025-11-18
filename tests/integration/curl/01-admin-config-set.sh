#!/usr/bin/env bash
# 管理员配置 AI 服务并执行连接测试
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_ADMIN_COOKIE:?HYDRO_ADMIN_COOKIE not set. Please export HYDRO_ADMIN_COOKIE=\"sid=...\"}"

API_BASE_URL="${HYDRO_AI_API_BASE_URL:-https://api.openai.com/v1}"
MODEL_NAME="${HYDRO_AI_MODEL_NAME:-gpt-3.5-turbo}"
API_KEY="${HYDRO_AI_API_KEY:-sk-REPLACE-ME}"
RATE_LIMIT="${HYDRO_AI_RATE_LIMIT:-5}"
TIMEOUT="${HYDRO_AI_TIMEOUT:-30}"
SYSTEM_PROMPT="${HYDRO_AI_SYSTEM_PROMPT:-You are a helpful teaching assistant.}"

echo "[T026] 01-admin-config-set: set config & test connection"
echo "Using BASE_URL=${BASE_URL}"

CONFIG_PAYLOAD=$(cat <<EOF
{
  "apiBaseUrl": "$API_BASE_URL",
  "modelName": "$MODEL_NAME",
  "apiKey": "$API_KEY",
  "rateLimitPerMinute": $RATE_LIMIT,
  "timeoutSeconds": $TIMEOUT,
  "systemPromptTemplate": "$SYSTEM_PROMPT"
}
EOF
)

echo "--- Updating config ---"
response=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" -X PUT "$BASE_URL/ai-helper/admin/config" \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d "$CONFIG_PAYLOAD")

body=$(printf "%s" "$response" | sed '/HTTP_STATUS:/d')
status=$(printf "%s" "$response" | sed -n 's/.*HTTP_STATUS://p')
echo "$body"
if [ "$status" != "200" ]; then
  echo "Unexpected status while updating config: $status" >&2
  exit 1
fi

echo "--- Test connection ---"
test_resp=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" -X POST "$BASE_URL/ai-helper/admin/test-connection" \
  -H "Cookie: $COOKIE")

test_body=$(printf "%s" "$test_resp" | sed '/HTTP_STATUS:/d')
test_status=$(printf "%s" "$test_resp" | sed -n 's/.*HTTP_STATUS://p')
echo "$test_body"
if [ "$test_status" != "200" ]; then
  echo "Unexpected status while testing connection: $test_status" >&2
  exit 1
fi

echo "[Done] admin config updated and connection tested."
