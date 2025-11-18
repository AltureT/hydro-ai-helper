#!/usr/bin/env bash
# 查看统计数据
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_TEACHER_COOKIE:?HYDRO_TEACHER_COOKIE not set. Use a teacher/admin sid.}"

DIMENSION="${HYDRO_ANALYTICS_DIMENSION:-problem}" # class|problem|student
START_DATE="${HYDRO_ANALYTICS_START_DATE:-}"
END_DATE="${HYDRO_ANALYTICS_END_DATE:-}"
CLASS_ID="${HYDRO_ANALYTICS_CLASS_ID:-}"
PROBLEM_ID="${HYDRO_ANALYTICS_PROBLEM_ID:-}"

echo "[T026] 06-analytics: fetch analytics (${DIMENSION})"
echo "Using BASE_URL=${BASE_URL}"

query="dimension=${DIMENSION}"
[ -n "$START_DATE" ] && query="${query}&startDate=${START_DATE}"
[ -n "$END_DATE" ] && query="${query}&endDate=${END_DATE}"
[ -n "$CLASS_ID" ] && query="${query}&classId=${CLASS_ID}"
[ -n "$PROBLEM_ID" ] && query="${query}&problemId=${PROBLEM_ID}"

response=$(curl -sS -w "\nHTTP_STATUS:%{http_code}" "$BASE_URL/ai-helper/analytics?${query}" \
  -H "Cookie: $COOKIE" \
  -H "Accept: application/json")

body=$(printf "%s" "$response" | sed '/HTTP_STATUS:/d')
status=$(printf "%s" "$response" | sed -n 's/.*HTTP_STATUS://p')
echo "$body"

if [ "$status" != "200" ]; then
  echo "Unexpected status when fetching analytics: $status" >&2
  exit 1
fi

if [ "${RUN_INVALID_DIMENSION_CHECK:-0}" != "0" ]; then
  invalid_status=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/ai-helper/analytics?dimension=invalid" \
    -H "Cookie: $COOKIE" \
    -H "Accept: application/json")
  echo "Invalid dimension check status (expected 400): ${invalid_status}"
fi

echo "[Done] analytics fetched."
