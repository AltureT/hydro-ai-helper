#!/usr/bin/env bash
# 导出 CSV，默认写入临时文件
set -euo pipefail

BASE_URL="${HYDRO_BASE_URL:-http://127.0.0.1}"
COOKIE="${HYDRO_TEACHER_COOKIE:?HYDRO_TEACHER_COOKIE not set. Use a teacher/admin sid.}"

START_DATE="${HYDRO_EXPORT_START_DATE:-}"
END_DATE="${HYDRO_EXPORT_END_DATE:-}"
CLASS_ID="${HYDRO_EXPORT_CLASS_ID:-}"
PROBLEM_ID="${HYDRO_EXPORT_PROBLEM_ID:-}"
USER_ID="${HYDRO_EXPORT_USER_ID:-}"
INCLUDE_SENSITIVE="${HYDRO_EXPORT_INCLUDE_SENSITIVE:-false}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_FILE="${EXPORT_OUTPUT_FILE:-$(mktemp "${SCRIPT_DIR}/export-XXXX.csv")}"

echo "[T026] 05-export: export conversations to CSV"
echo "Using BASE_URL=${BASE_URL}"

query="format=csv&includeSensitive=${INCLUDE_SENSITIVE}"
[ -n "$START_DATE" ] && query="${query}&startDate=${START_DATE}"
[ -n "$END_DATE" ] && query="${query}&endDate=${END_DATE}"
[ -n "$CLASS_ID" ] && query="${query}&classId=${CLASS_ID}"
[ -n "$PROBLEM_ID" ] && query="${query}&problemId=${PROBLEM_ID}"
[ -n "$USER_ID" ] && query="${query}&userId=${USER_ID}"

status=$(curl -sS -o "$OUTPUT_FILE" -w "%{http_code}" "$BASE_URL/ai-helper/export?${query}" \
  -H "Cookie: $COOKIE" \
  -H "Accept: text/csv")

if [ "$status" != "200" ]; then
  echo "Unexpected status when exporting: $status" >&2
  echo "Response:" >&2
  cat "$OUTPUT_FILE" >&2
  exit 1
fi

echo "Export saved to: $OUTPUT_FILE"
head -n 5 "$OUTPUT_FILE"

if [ "${RUN_INVALID_FORMAT_CHECK:-0}" != "0" ]; then
  invalid_status=$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/ai-helper/export?format=json" \
    -H "Cookie: $COOKIE" \
    -H "Accept: application/json")
  echo "Invalid format check status (expected 400): ${invalid_status}"
fi

echo "[Done] export completed."
