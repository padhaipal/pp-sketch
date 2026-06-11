#!/usr/bin/env bash
# Fetch logs + GitHub data for a PadhaiPal digest.
# Usage: fetch-digest-data.sh <mode> <window> [user_id]
#   mode    = daily | user-test
#   window  = e.g. 24h, 2h
#   user_id = optional, used only by user-test mode
#
# Env: GRAFANA_URL, GRAFANA_API_KEY, GH_TOKEN (set by GH Actions GITHUB_TOKEN)
# Writes /tmp/digest-input.json

set -euo pipefail

mode="${1:?mode required}"
window="${2:?window required}"
user_id="${3:-}"

if [[ ! "$window" =~ ^[0-9]+[hmd]$ ]]; then
  echo "window must look like 24h / 30m / 7d" >&2
  exit 1
fi

# window → seconds
unit="${window: -1}"
amount="${window%?}"
case "$unit" in
  h) window_sec=$(( amount * 3600 )) ;;
  m) window_sec=$(( amount * 60 )) ;;
  d) window_sec=$(( amount * 86400 )) ;;
esac

now_sec=$(date -u +%s)
start_sec=$(( now_sec - window_sec ))
now_ns="${now_sec}000000000"
start_ns="${start_sec}000000000"

auth_hdr="Authorization: Bearer ${GRAFANA_API_KEY}"

# Loki datasource id. Viewer-role service-account tokens can query through the
# proxy but can't list /api/datasources, so we hardcode the id we already
# discovered (override via env if it ever moves).
loki_ds_id="${LOKI_DATASOURCE_ID:-7}"
loki_proxy="${GRAFANA_URL}/api/datasources/proxy/${loki_ds_id}/loki/api/v1"
echo "Using Loki datasource id=${loki_ds_id}" >&2

# Body separator used by curl to write http status on its own line
SEP='__HTTP_STATUS__'

# Wraps curl response { body, http_status } and validates the response is JSON;
# prints body + status on failure.
require_json() {
  local label="$1" raw="$2"
  local status="${raw##*${SEP}}"
  local body="${raw%${SEP}*}"
  if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    echo "ERROR: ${label} returned non-JSON. HTTP status=${status}. Body (first 2KB):" >&2
    printf '%s' "$body" | head -c 2048 >&2
    echo >&2
    echo "(URL: ${loki_proxy})" >&2
    exit 1
  fi
  printf '%s' "$body"
}

loki_query_range() {
  local q="$1" start="$2" end="$3" limit="${4:-5000}"
  curl -sS -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$q" \
    --data-urlencode "start=$start" \
    --data-urlencode "end=$end" \
    --data-urlencode "limit=$limit" \
    --data-urlencode "direction=backward" \
    "${loki_proxy}/query_range"
}

loki_instant() {
  local q="$1" t="$2"
  curl -sS -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$q" \
    --data-urlencode "time=$t" \
    "${loki_proxy}/query"
}

services='pp-sketch|wabot-sketch|pp-dashboard'
severity='WARN|ERROR|FATAL'

# Primary window: raw error/warn/fatal lines across services × envs
primary_query="{service_name=~\"${services}\", severity_text=~\"${severity}\"}"
if [[ -n "$user_id" ]]; then
  primary_query="${primary_query} |~ \"${user_id}\""
fi
primary_raw=$(loki_query_range "$primary_query" "$start_ns" "$now_ns" 5000)
primary=$(require_json "primary loki query" "$primary_raw")

# Daily-only: 7d hourly aggregates + 30d daily aggregates
week_agg='null'
month_agg='null'
if [[ "$mode" == "daily" ]]; then
  week_start_ns=$(( (now_sec - 7*86400) * 1000000000 ))
  month_start_ns=$(( (now_sec - 30*86400) * 1000000000 ))
  week_q="sum by (service_name, deployment_environment, severity_text) (count_over_time({service_name=~\"${services}\", severity_text=~\"${severity}\"}[1h]))"
  month_q="sum by (service_name, deployment_environment, severity_text) (count_over_time({service_name=~\"${services}\", severity_text=~\"${severity}\"}[1d]))"
  week_raw=$(curl -sS -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$week_q" \
    --data-urlencode "start=$week_start_ns" \
    --data-urlencode "end=$now_ns" \
    --data-urlencode "step=3600" \
    "${loki_proxy}/query_range")
  week_agg=$(require_json "week aggregate" "$week_raw")
  month_raw=$(curl -sS -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$month_q" \
    --data-urlencode "start=$month_start_ns" \
    --data-urlencode "end=$now_ns" \
    --data-urlencode "step=86400" \
    "${loki_proxy}/query_range")
  month_agg=$(require_json "month aggregate" "$month_raw")
fi

# GitHub runs + open PRs (daily mode only)
gh_runs='null'
gh_prs='null'
if [[ "$mode" == "daily" ]] && command -v gh >/dev/null 2>&1; then
  since_iso=$(date -u -d "@${start_sec}" -Iseconds 2>/dev/null || date -u -r "${start_sec}" -Iseconds)
  gh_runs=$(gh run list --limit 100 --json conclusion,name,createdAt,headBranch,event,databaseId --jq "map(select(.createdAt > \"${since_iso}\"))" 2>/dev/null || echo 'null')
  gh_prs=$(gh pr list --state open --limit 50 --json number,title,createdAt,updatedAt,author,headRefName 2>/dev/null || echo 'null')
fi

jq -n \
  --arg mode "$mode" \
  --arg window "$window" \
  --arg user_id "$user_id" \
  --arg start "$start_ns" \
  --arg end "$now_ns" \
  --argjson primary_logs "$primary" \
  --argjson week_aggregate "$week_agg" \
  --argjson month_aggregate "$month_agg" \
  --argjson gh_runs "$gh_runs" \
  --argjson gh_prs "$gh_prs" \
  '{mode: $mode, window: $window, user_id: $user_id, window_start_ns: $start, window_end_ns: $end,
    primary_logs: $primary_logs, week_aggregate: $week_aggregate, month_aggregate: $month_aggregate,
    gh_runs: $gh_runs, gh_prs: $gh_prs}' \
  > /tmp/digest-input.json

printf 'wrote /tmp/digest-input.json (%s bytes, mode=%s, window=%s)\n' \
  "$(wc -c </tmp/digest-input.json)" "$mode" "$window"
