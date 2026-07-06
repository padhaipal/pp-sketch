#!/usr/bin/env bash
# Authenticated Grafana datasource-proxy query.
# Usage: grafana-query.sh <datasource-uid> <api-path> [extra curl args...]
#   grafana-query.sh prometheus api/v1/query --data-urlencode 'query=up'
#   grafana-query.sh loki loki/api/v1/query_range --data-urlencode 'query={service_name="pp-sketch"}' --data-urlencode 'limit=10'
#   grafana-query.sh tempo api/search --data-urlencode 'limit=5'
#
# Reads GRAFANA_URL + GRAFANA_API_KEY from the environment itself so callers
# (including the digest LLM, whose sandbox blocks $SECRET expansion in
# commands) never need to expand secrets in their own command lines.
set -euo pipefail

uid="${1:?datasource uid required (loki|prometheus|tempo)}"
path="${2:?api path required, e.g. api/v1/query}"
shift 2

url="${GRAFANA_URL%/}/api/datasources/proxy/uid/${uid}/${path}"
curl -sSL -G -H "Authorization: Bearer ${GRAFANA_API_KEY}" "$@" "$url"
