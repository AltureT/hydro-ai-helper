#!/usr/bin/env bash
# 教师/管理员查看对话列表，可附带筛选参数
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_TEACHER_COOKIE:?HYDRO_TEACHER_COOKIE not set. Use a teacher/admin sid.}"

# 可选筛选
START_DATE="${HYDRO_LIST_START_DATE:-}"
END_DATE="${HYDRO_LIST_END_DATE:-}"
PROBLEM_ID="${HYDRO_LIST_PROBLEM_ID:-}"
CLASS_ID="${HYDRO_LIST_CLASS_ID:-}"
USER_ID="${HYDRO_LIST_USER_ID:-}"
LIMIT="${HYDRO_LIST_LIMIT:-20}"
PAGE="${HYDRO_LIST_PAGE:-1}"

echo "[T026] 03-teacher-list: fetch conversation list"
echo "Using BASE_URL=${BASE_URL}"

query="page=${PAGE}&limit=${LIMIT}"
[ -n "$START_DATE" ] && query="${query}&startDate=${START_DATE}"
[ -n "$END_DATE" ] && query="${query}&endDate=${END_DATE}"
[ -n "$PROBLEM_ID" ] && query="${query}&problemId=${PROBLEM_ID}"
[ -n "$CLASS_ID" ] && query="${query}&classId=${CLASS_ID}"
[ -n "$USER_ID" ] && query="${query}&userId=${USER_ID}"

response=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" "$BASE_URL/ai-helper/conversations?${query}" \
  -H "Cookie: $COOKIE" \
  -H "Accept: application/json")

body=$(printf "%s" "$response" | sed '/HTTP_STATUS:/d')
status=$(printf "%s" "$response" | sed -n 's/.*HTTP_STATUS://p')
echo "$body"

if [ "$status" != "200" ]; then
  echo "Unexpected status when listing conversations: $status" >&2
  exit 1
fi

# Optional negative test for invalid date range
if [ "${RUN_INVALID_DATE_CHECK:-0}" != "0" ]; then
  invalid_status=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/ai-helper/conversations?startDate=INVALID_DATE" \
    -H "Cookie: $COOKIE" \
    -H "Accept: application/json")
  echo "Invalid date check status (expected 400): ${invalid_status}"
fi

echo "[Done] conversation list fetched."
