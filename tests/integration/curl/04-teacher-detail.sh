#!/usr/bin/env bash
# 教师/管理员查看对话详情
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_TEACHER_COOKIE:?HYDRO_TEACHER_COOKIE not set. Use a teacher/admin sid.}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/.conversation_id"

CONVERSATION_ID="${HYDRO_CONVERSATION_ID:-}"
if [ -z "$CONVERSATION_ID" ] && [ -f "$STATE_FILE" ]; then
  CONVERSATION_ID="$(cat "$STATE_FILE")"
fi

if [ -z "$CONVERSATION_ID" ]; then
  echo "Missing conversationId. Set HYDRO_CONVERSATION_ID or run 02-student-chat.sh first." >&2
  exit 1
fi

echo "[T026] 04-teacher-detail: fetch conversation detail ${CONVERSATION_ID}"
echo "Using BASE_URL=${BASE_URL}"

response=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" "$BASE_URL/ai-helper/conversations/${CONVERSATION_ID}" \
  -H "Cookie: $COOKIE" \
  -H "Accept: application/json")

body=$(printf "%s" "$response" | sed '/HTTP_STATUS:/d')
status=$(printf "%s" "$response" | sed -n 's/.*HTTP_STATUS://p')
echo "$body"

if [ "$status" != "200" ]; then
  echo "Unexpected status when fetching detail: $status" >&2
  exit 1
fi

echo "[Done] conversation detail fetched."
