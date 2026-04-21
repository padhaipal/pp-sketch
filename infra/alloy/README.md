# Alloy on Railway

This folder contains the Docker build context for running Grafana Alloy as the internal OTLP collector for `pp-sketch`.

Alloy is a dedicated service (separate from `pp-sketch` itself) that receives OTLP traces, metrics, and logs from the `pp-sketch` app and forwards them to Grafana Cloud.

`pp-sketch` runs its own Alloy instance (parallel to the one in `wabot-sketch/infra/alloy/`) so that an Alloy outage or bad config affects only one app at a time.

## Files

- `config.alloy`: Alloy pipeline (receiver -> processors -> exporter to Grafana Cloud)
- `Dockerfile`: Builds an Alloy container with `config.alloy` at `/etc/alloy/config.alloy`

## Railway Setup

1. Create a new Railway service from this folder (`pp-sketch/infra/alloy`).
2. Add these environment variables to the Alloy service:
   - `GRAFANA_CLOUD_OTLP_ENDPOINT`
   - `GRAFANA_CLOUD_INSTANCE_ID`
   - `GRAFANA_CLOUD_API_TOKEN`
3. Deploy.
4. In the `pp-sketch` service, set:
   - `OTEL_EXPORTER_OTLP_ENDPOINT=http://<alloy-service-name>.railway.internal:4318`
   - `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
   - `OTEL_TRACES_EXPORTER=otlp`
   - `OTEL_METRICS_EXPORTER=otlp`
   - `OTEL_LOGS_EXPORTER=otlp`
   - `OTEL_SERVICE_NAME=pp-sketch`
   - `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=production,service.version=<git sha or tag>`

   Replace `<alloy-service-name>` with the Railway service name you gave this Alloy deployment (e.g. `alloy-pp`). Do **not** point `pp-sketch` at the `wabot-sketch` Alloy — each app has its own Alloy to isolate blast radius.

## Security note

Do not hardcode Grafana Cloud tokens into source files.
Use Railway environment variables only.
