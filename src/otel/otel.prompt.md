This file is used by main.ts to initialize OTel SDK for this repository.
OTel data is exported to a separate Railway service running Grafana Alloy.
Alloy forwards OTel data to Grafana Cloud.

The following environment variables are available in .env:
* OTEL_SERVICE_NAME
* OTEL_EXPORTER_OTLP_ENDPOINT
* OTEL_TRACES_EXPORTER
* OTEL_METRICS_EXPORTER
* OTEL_LOGS_EXPORTER
* OTEL_RESOURCE_ATTRIBUTES
* OTEL_EXPORTER_OTLP_PROTOCOL
