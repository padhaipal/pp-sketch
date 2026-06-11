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

# Normalize: strip trailing slash, force https scheme.
grafana_url="${GRAFANA_URL%/}"
grafana_url="${grafana_url/#http:/https:}"
if [[ "$grafana_url" != "$GRAFANA_URL" ]]; then
  echo "Normalized GRAFANA_URL → ${grafana_url}" >&2
fi

auth_hdr="Authorization: Bearer ${GRAFANA_API_KEY}"

# Loki datasource id. Viewer-role service-account tokens can query through the
# proxy but can't list /api/datasources, so we hardcode the id we already
# discovered (override via env if it ever moves).
loki_ds_id="${LOKI_DATASOURCE_ID:-7}"
loki_proxy="${grafana_url}/api/datasources/proxy/${loki_ds_id}/loki/api/v1"
echo "Using Loki datasource id=${loki_ds_id} via ${loki_proxy}" >&2

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
  curl -sSL -G -H "$auth_hdr" \
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
  curl -sSL -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$q" \
    --data-urlencode "time=$t" \
    "${loki_proxy}/query"
}

services='pp-sketch|wabot-sketch|pp-dashboard'
severity='WARN|ERROR|FATAL'

# Loki indexed labels here are only {deployment_environment, service_name}.
# severity_text is structured metadata, so it MUST be filtered via pipe syntax
# (| severity_text=~"...") — putting it in the stream selector returns 0 rows.
primary_query="{service_name=~\"${services}\"} | severity_text=~\"${severity}\""
if [[ -n "$user_id" ]]; then
  primary_query="${primary_query} |~ \"${user_id}\""
fi
primary_raw=$(loki_query_range "$primary_query" "$start_ns" "$now_ns" 5000)
primary=$(require_json "primary loki query" "$primary_raw")
echo "primary: status=$(printf '%s' "$primary" | jq -r '.status // "n/a"') streams=$(printf '%s' "$primary" | jq -r '.data.result | length') sample=$(printf '%s' "$primary" | jq -rc '.data.result[0].stream // {}' 2>/dev/null | head -c 200)" >&2

# Pre-aggregate primary logs so Claude doesn't have to digest raw multi-MB JSON.
#   summary: counts by service × env × severity
#   clusters: groups by (service, env, severity, first 80 chars of message),
#             with count + up to 3 sample lines per cluster, sorted by count desc.
primary_compact=$(printf '%s' "$primary" | jq -c '
  .data.result as $streams
  | {
      total_streams: ($streams | length),
      total_lines: ([$streams[].values | length] | add // 0),
      summary: (
        [$streams[] | {
          service: (.stream.service_name // "unknown"),
          env: (.stream.deployment_environment // "unknown"),
          severity: (.stream.severity_text // "unknown"),
          count: (.values | length)
        }]
        | group_by(.service + "|" + .env + "|" + .severity)
        | map({
            service: .[0].service, env: .[0].env, severity: .[0].severity,
            count: (map(.count) | add)
          })
        | sort_by(-.count)
      ),
      clusters: (
        [$streams[]
          | (.stream) as $s
          | .values[]
          | {
              service: ($s.service_name // "unknown"),
              env: ($s.deployment_environment // "unknown"),
              severity: ($s.severity_text // "unknown"),
              log_context: ($s.log_context // null),
              ts_ns: .[0],
              msg: .[1]
            }
        ]
        | group_by(.service + "|" + .env + "|" + .severity + "|" + (.msg[0:80]))
        | map({
            service: .[0].service, env: .[0].env, severity: .[0].severity,
            log_context: .[0].log_context,
            msg_prefix: (.[0].msg[0:80]),
            count: length,
            samples: ([.[0:3] | .[] | {ts_ns, msg: (.msg[0:400])}])
          })
        | sort_by(-.count)
      )
    }
')
echo "primary_compact: clusters=$(printf '%s' "$primary_compact" | jq -r '.clusters | length') total_lines=$(printf '%s' "$primary_compact" | jq -r '.total_lines') bytes=$(printf '%s' "$primary_compact" | wc -c)" >&2

# Daily-only: 7d hourly aggregates + 30d daily aggregates
week_agg='null'
month_agg='null'
if [[ "$mode" == "daily" ]]; then
  week_start_ns=$(( (now_sec - 7*86400) * 1000000000 ))
  month_start_ns=$(( (now_sec - 30*86400) * 1000000000 ))
  week_q="sum by (service_name, deployment_environment, severity_text) (count_over_time({service_name=~\"${services}\"} | severity_text=~\"${severity}\" [1h]))"
  month_q="sum by (service_name, deployment_environment, severity_text) (count_over_time({service_name=~\"${services}\"} | severity_text=~\"${severity}\" [1d]))"
  week_raw=$(curl -sSL -G -H "$auth_hdr" \
    -w "\n${SEP}%{http_code}" \
    --data-urlencode "query=$week_q" \
    --data-urlencode "start=$week_start_ns" \
    --data-urlencode "end=$now_ns" \
    --data-urlencode "step=3600" \
    "${loki_proxy}/query_range")
  week_agg=$(require_json "week aggregate" "$week_raw")
  month_raw=$(curl -sSL -G -H "$auth_hdr" \
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

mkdir -p /tmp/digest-staging
printf '%s' "$primary_compact" > /tmp/digest-staging/primary.json
printf '%s' "$week_agg"        > /tmp/digest-staging/week.json
printf '%s' "$month_agg"       > /tmp/digest-staging/month.json
printf '%s' "$gh_runs"         > /tmp/digest-staging/runs.json
printf '%s' "$gh_prs"          > /tmp/digest-staging/prs.json
# Keep the full raw primary as an artifact, but don't put it into the LLM input.
printf '%s' "$primary"         > /tmp/digest-staging/primary-raw.json

jq -n \
  --slurpfile p  /tmp/digest-staging/primary.json \
  --slurpfile w  /tmp/digest-staging/week.json \
  --slurpfile m  /tmp/digest-staging/month.json \
  --slurpfile r  /tmp/digest-staging/runs.json \
  --slurpfile pr /tmp/digest-staging/prs.json \
  --arg mode "$mode" \
  --arg window "$window" \
  --arg user_id "$user_id" \
  --arg start "$start_ns" \
  --arg end "$now_ns" \
  '{mode: $mode, window: $window, user_id: $user_id, window_start_ns: $start, window_end_ns: $end,
    primary_logs: $p[0], week_aggregate: $w[0], month_aggregate: $m[0],
    gh_runs: $r[0], gh_prs: $pr[0]}' \
  > /tmp/digest-input.json

printf 'wrote /tmp/digest-input.json (%s bytes, mode=%s, window=%s)\n' \
  "$(wc -c </tmp/digest-input.json)" "$mode" "$window"
echo "gh_runs: $(printf '%s' "$gh_runs" | jq -r 'if . == null then "null" else length | tostring + " runs" end')" >&2
echo "gh_prs: $(printf '%s' "$gh_prs" | jq -r 'if . == null then "null" else length | tostring + " open PRs" end')" >&2
