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

// POST /media-meta-data/elevenlabs-generate
// Same pattern as heygen-generate but uses CreateElevenlabsMediaOptions / validateCreateElevenlabsMediaOptions.
// Swagger: @ApiTags('media-meta-data'), @ApiBody({ type: CreateElevenlabsMediaOptions }), @ApiResponse(202)
generateElevenlabsMedia()
1.) Validate request body with validateCreateElevenlabsMediaOptions(). If fails: return 400.
2.) Start root span: startRootSpan('elevenlabs-generate-controller').
3.) Call mediaMetaDataService.createElevenlabsMedia(validated, injectCarrier(span)).
4.) Return 202 with { created: <count>, entities }.
5.) End span.

// POST /media-meta-data/upload-static
// Creates static media_metadata rows from the admin dashboard. Supports all media types:
//   * image / video (MP4 "GIF") / audio — file bytes uploaded as multipart, written to S3, then WHATSAPP_PRELOAD jobs enqueued.
//   * text — no file, no S3 upload, no WHATSAPP_PRELOAD; the row is created directly with the inline `text` field and is immediately ready.
// Each items[i] declares its media_type. For non-text types there must be a corresponding files[i]; for text there must NOT be a file (text items carry their content inline in the `text` field).
// Swagger: @ApiTags('media-meta-data'), @ApiConsumes('multipart/form-data'), @ApiResponse(201)
// @UseInterceptors(FilesInterceptor('files', 50))
uploadStaticMedia()
1.) Parse the `items` form field (JSON string) into an array via JSON.parse.
  * If JSON.parse fails: return 400.
  * Validate with validateUploadStaticMediaItems(). If validation fails: return 400. Validation must enforce: text items have a non-empty `text` field and no associated file; non-text items have no `text` field.
2.) Validate files against items:
  * Let nonTextItems = items where media_type !== 'text'. files.length must equal nonTextItems.length (files may be empty if all items are text). If not: return 400.
  * Files are matched to non-text items in order. For each non-text item at non-text-index j: call assertValidStaticMediaFile(files[j], j). If any fails: return 400.
3.) Start a root span: `startRootSpan('upload-static-controller')` (no incoming OTel carrier — dashboard request).
4.) Call src/media-meta-data/media-meta-data.service.ts/uploadStaticMedia(files, validatedItems, injectCarrier(span)). The service is responsible for skipping S3 upload and WHATSAPP_PRELOAD enqueue for text items, and for inserting them with status='ready'.
5.) End the span.
6.) Return 201 with UploadStaticMediaResult body.
