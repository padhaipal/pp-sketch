// pp-sketch/src/media-meta-data/media-meta-data.controller.prompt.md

// POST endpoint accepting a generation request JSON package from the dashboard.
// Called by the dev React dashboard via Swagger.
// No authentication or authorization — any entity with dashboard access is trusted.

// Swagger: @ApiTags('media-meta-data'), @ApiBody({ type: CreateHeygenMediaOptions }), @ApiResponse(202)

// POST /media-meta-data/heygen-generate
generateHeygenMedia()
1.) Validate the request body against src/media-meta-data/media-meta-data.dto.ts (CreateHeygenMediaOptions)
    using validateCreateHeygenMediaOptions().
  * If validation fails: return 400.
2.) Start a root span: `startRootSpan('heygen-generate-controller')` (no incoming OTel carrier — dashboard request). See src/otel/otel.prompt.md for helpers.
3.) Call src/media-meta-data/media-meta-data.service.ts/createHeygenMedia() with the validated options and `injectCarrier(span)`.
  * If the service throws: let it propagate (NestJS will map to the appropriate HTTP status).
4.) Return 202 Accepted with body: { created: <number of items>, entities: <returned MediaMetaData[]> }.
5.) End the span.
