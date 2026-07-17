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

# Loki datasource uid. Defaults to Grafana Cloud's provisioned uid
# (2026-07-13 cutover); override via env when pointing at a self-hosted
# otel-lgtm instance (which provisions loki/prometheus/tempo).
loki_ds_uid="${LOKI_DATASOURCE_UID:-grafanacloud-logs}"
loki_proxy="${grafana_url}/api/datasources/proxy/uid/${loki_ds_uid}/loki/api/v1"
echo "Using Loki datasource uid=${loki_ds_uid} via ${loki_proxy}" >&2

# Grafana Cloud free-tier stacks HIBERNATE after a few days without UI
# logins: /api/health serves 404/503 and datasource proxy calls fail with
# DatasourceError until the first request wakes the stack (~1-3 min).
# The digest is often that first request (scheduled, nobody logged in),
# which is exactly how the 2026-07-16/17 runs died. Poll health until the
# stack is up; give it 5 minutes before declaring a real outage.
wake_deadline=$(( $(date -u +%s) + 300 ))
until [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${grafana_url}/api/health" 2>/dev/null)" == "200" ]]; do
  if (( $(date -u +%s) >= wake_deadline )); then
    echo "ERROR: Grafana at ${grafana_url} not healthy after 5 min of wake attempts" >&2
    exit 1
  fi
  echo "Grafana not ready (hibernating?) — retrying in 15s" >&2
  sleep 15
done

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
primary_status=$(printf '%s' "$primary" | jq -r '.status // "error"')
if [[ "$primary_status" != "success" ]]; then
  echo "ERROR: primary loki query returned status=${primary_status}. Body (first 500B):" >&2
  printf '%s' "$primary" | head -c 500 >&2
  echo >&2
  exit 1
fi
echo "primary: status=${primary_status} streams=$(printf '%s' "$primary" | jq -r '.data.result | length') sample=$(printf '%s' "$primary" | jq -rc '.data.result[0].stream // {}' 2>/dev/null | head -c 200)" >&2

# Pre-aggregate primary logs so Claude doesn't have to digest raw multi-MB JSON.
#   summary: counts by service × env × severity
#   clusters: groups by (service, env, severity, first 80 chars of message),
#             with count + up to 3 sample lines per cluster, sorted by count desc.
primary_compact=$(printf '%s' "$primary" | jq -c '
  (.data.result // []) as $streams
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
            samples: ([.[0:2] | .[] | {ts_ns, msg: (.msg[0:200])}])
          })
        | sort_by(-.count)
        | .[0:100]  # cap to top-100 clusters (tail is usually 1-count noise)
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

# Load-test metrics prefetch (daily mode only). The digest LLM's sandbox
# blocks $SECRET expansion in its commands, so it cannot query Prometheus
# itself — everything its Load-test section needs is pre-fetched here.
# Load tests run on staging, whose telemetry lives on the STAGING Grafana
# instance — prefer GRAFANA_STAGING_URL/KEY when set, else fall back to the
# primary instance. Tolerant: a failed query becomes null (reported as
# not-retrieved), never aborts the digest.
lt_url="${GRAFANA_STAGING_URL:-$GRAFANA_URL}"
lt_url="${lt_url%/}"
lt_url="${lt_url/#http:/https:}"
lt_auth_hdr="Authorization: Bearer ${GRAFANA_STAGING_API_KEY:-$GRAFANA_API_KEY}"
prom_proxy="${lt_url}/api/datasources/proxy/uid/${PROM_DATASOURCE_UID:-grafanacloud-prom}"
prom_result() {
  local q="$1"
  curl -sSL -G -H "$lt_auth_hdr" \
    --data-urlencode "query=$q" \
    --data-urlencode "time=$now_sec" \
    "${prom_proxy}/api/v1/query" 2>/dev/null \
    | jq -c 'if .status == "success" then .data.result else null end' 2>/dev/null \
    || echo null
}

loadtest_metrics='null'
if [[ "$mode" == "daily" ]]; then
  e2e='wabot_message_e2e_duration_ms_milliseconds'
  loadtest_metrics='{}'
  for spec in \
    "e2e_p50_ms;histogram_quantile(0.50, sum by (test_phase, le) (increase(${e2e}_bucket{load_test=\"true\",outcome=\"delivered\"}[${window}])))" \
    "e2e_p95_ms;histogram_quantile(0.95, sum by (test_phase, le) (increase(${e2e}_bucket{load_test=\"true\",outcome=\"delivered\"}[${window}])))" \
    "e2e_p99_ms;histogram_quantile(0.99, sum by (test_phase, le) (increase(${e2e}_bucket{load_test=\"true\",outcome=\"delivered\"}[${window}])))" \
    "e2e_outcomes;sum by (test_phase, outcome) (increase(${e2e}_count{load_test=\"true\"}[${window}]))" \
    "wabot_dwell_p95_ms;histogram_quantile(0.95, sum by (queue_name, le) (increase(wabot_bullmq_job_dwell_duration_ms_milliseconds_bucket{load_test=\"true\"}[${window}])))" \
    "pp_dwell_p95_ms;histogram_quantile(0.95, sum by (queue_name, le) (increase(pp_bullmq_job_dwell_duration_ms_milliseconds_bucket{load_test=\"true\"}[${window}])))" \
    "eventloop_util_max;max by (job) (max_over_time(nodejs_eventloop_utilization_ratio[${window}]))" \
    "db_op_p95_ms;histogram_quantile(0.95, sum by (db_operation_name, le) (increase(db_client_operation_duration_seconds_bucket[${window}]))) * 1000"
  do
    name="${spec%%;*}"
    q="${spec#*;}"
    val=$(prom_result "$q")
    [[ -z "$val" ]] && val='null'
    loadtest_metrics=$(printf '%s' "$loadtest_metrics" \
      | jq -c --arg k "$name" --argjson v "$val" '. + {($k): $v}')
  done
  echo "loadtest_metrics: $(printf '%s' "$loadtest_metrics" | jq -r 'to_entries | map("\(.key)=\(if .value == null then "null" else (.value | length | tostring) + " series" end)") | join(", ")')" >&2
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
printf '%s' "$primary_compact"  > /tmp/digest-staging/primary.json
printf '%s' "$week_agg"         > /tmp/digest-staging/week.json
printf '%s' "$month_agg"        > /tmp/digest-staging/month.json
printf '%s' "$gh_runs"          > /tmp/digest-staging/runs.json
printf '%s' "$gh_prs"           > /tmp/digest-staging/prs.json
printf '%s' "$loadtest_metrics" > /tmp/digest-staging/loadtest.json
# Keep the full raw primary as an artifact, but don't put it into the LLM input.
printf '%s' "$primary"         > /tmp/digest-staging/primary-raw.json

jq -n \
  --slurpfile p  /tmp/digest-staging/primary.json \
  --slurpfile w  /tmp/digest-staging/week.json \
  --slurpfile m  /tmp/digest-staging/month.json \
  --slurpfile r  /tmp/digest-staging/runs.json \
  --slurpfile pr /tmp/digest-staging/prs.json \
  --slurpfile lt /tmp/digest-staging/loadtest.json \
  --arg mode "$mode" \
  --arg window "$window" \
  --arg user_id "$user_id" \
  --arg start "$start_ns" \
  --arg end "$now_ns" \
  '{mode: $mode, window: $window, user_id: $user_id, window_start_ns: $start, window_end_ns: $end,
    primary_logs: $p[0], week_aggregate: $w[0], month_aggregate: $m[0],
    gh_runs: $r[0], gh_prs: $pr[0], loadtest_metrics: $lt[0]}' \
  > /tmp/digest-input.json

printf 'wrote /tmp/digest-input.json (%s bytes, mode=%s, window=%s)\n' \
  "$(wc -c </tmp/digest-input.json)" "$mode" "$window"
echo "gh_runs: $(printf '%s' "$gh_runs" | jq -r 'if . == null then "null" else length | tostring + " runs" end')" >&2
echo "gh_prs: $(printf '%s' "$gh_prs" | jq -r 'if . == null then "null" else length | tostring + " open PRs" end')" >&2
