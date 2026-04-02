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
// Multipart upload of static images / MP4 "GIF" videos from the admin dashboard.
// Files are uploaded to S3, media_metadata rows created, and WHATSAPP_PRELOAD jobs enqueued.
// Swagger: @ApiTags('media-meta-data'), @ApiConsumes('multipart/form-data'), @ApiResponse(201)
// @UseInterceptors(FilesInterceptor('files', 50))
uploadStaticMedia()
1.) Parse the `items` form field (JSON string) into an array via JSON.parse.
  * If JSON.parse fails: return 400.
  * Validate with validateUploadStaticMediaItems(). If validation fails: return 400.
2.) Validate files:
  * files must be a non-empty array with files.length === items.length. If not: return 400.
  * For each file at index i: call assertValidStaticMediaFile(file, i). If any fails: return 400.
3.) Start a root span: `startRootSpan('upload-static-controller')` (no incoming OTel carrier — dashboard request).
4.) Call src/media-meta-data/media-meta-data.service.ts/uploadStaticMedia(files, validatedItems, injectCarrier(span)).
5.) End the span.
6.) Return 201 with UploadStaticMediaResult body.
