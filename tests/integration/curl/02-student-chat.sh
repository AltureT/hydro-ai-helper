#!/usr/bin/env bash
# 学生端发起一次对话，返回 conversationId 并写入 .conversation_id
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_STUDENT_COOKIE:?HYDRO_STUDENT_COOKIE not set. Please export HYDRO_STUDENT_COOKIE=\"sid=...\"}"

PROBLEM_ID="${HYDRO_PROBLEM_ID:-P1000}"
PROBLEM_TITLE="${HYDRO_PROBLEM_TITLE:-Sample Problem}"
PROBLEM_SUMMARY="${HYDRO_PROBLEM_SUMMARY:-This is a short problem description for testing.}"
QUESTION_TYPE="${HYDRO_QUESTION_TYPE:-think}" # valid: understand|think|debug|review
USER_THINKING="${HYDRO_USER_THINKING:-我想用二分解决区间最大值，可以帮我验证思路吗？}"
INCLUDE_CODE="${HYDRO_CHAT_INCLUDE_CODE:-true}"
CODE_SNIPPET="${HYDRO_CHAT_CODE:-// sample code: int main(){ return 0; }}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="${SCRIPT_DIR}/.conversation_id"

echo "[T026] 02-student-chat: create a conversation"
echo "Using BASE_URL=${BASE_URL}"

payload=$(cat <<EOF
{
  "problemId": "$PROBLEM_ID",
  "problemTitle": "$PROBLEM_TITLE",
  "problemContent": "$PROBLEM_SUMMARY",
  "questionType": "$QUESTION_TYPE",
  "userThinking": "$USER_THINKING",
  "includeCode": $INCLUDE_CODE,
  "code": "$CODE_SNIPPET"
}
EOF
)

response=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" -X POST "$BASE_URL/ai-helper/chat" \
  -H "Cookie: $COOKIE" \
  -H "Content-Type: application/json" \
  -d "$payload")

body=$(printf "%s" "$response" | sed '/HTTP_STATUS:/d')
status=$(printf "%s" "$response" | sed -n 's/.*HTTP_STATUS://p')
echo "$body"

if [ "$status" != "200" ]; then
  echo "Unexpected status when chatting: $status" >&2
  exit 1
fi

conversation_id=$(printf "%s" "$body" | python3 - <<'PY' || true
import json, sys
try:
    data = json.load(sys.stdin)
    cid = data.get("conversationId")
    if cid:
        print(cid)
except Exception:
    pass
PY
)

if [ -z "${conversation_id:-}" ]; then
  echo "conversationId not found in response, please check output above." >&2
  exit 1
fi

echo "$conversation_id" > "$STATE_FILE"
echo "[Done] conversationId stored at $STATE_FILE"
