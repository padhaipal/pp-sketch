// pp-sketch/src/literacy/letters/letter.controller.prompt.md
// Admin dashboard endpoints for managing letters.
// Called by the dev React dashboard via Swagger.
// No authentication or authorization — any entity with dashboard access is trusted.

// Swagger: @ApiTags('letters')

// POST /letters
createLetter()
1.) Validate the request body with validateCreateLetterOptions(). If fails: return 400.
2.) Start a root span: startRootSpan('create-letter-controller').
3.) Call letter.service.ts/create() with the validated options.
   * If the service throws: let it propagate (NestJS maps to appropriate HTTP status).
4.) End the span. Return 201 with the created Letter entity.

// POST /letters/bulk
createLettersBulk()
1.) Validate the request body with validateCreateBulkLetterOptions(). If fails: return 400.
2.) Start a root span: startRootSpan('create-letters-bulk-controller').
3.) Call letter.service.ts/createBulk() with the validated options.
   * If the service throws: let it propagate.
4.) End the span. Return 201 with the created Letter[] array.

// PATCH /letters/:grapheme
updateLetter()
1.) Extract grapheme from the route param. Merge with the request body to form UpdateLetterOptions.
2.) Validate with validateUpdateLetterOptions(). If fails: return 400.
3.) Start a root span: startRootSpan('update-letter-controller').
4.) Call letter.service.ts/update() with the validated options.
   * If the service returns null: end the span, return 404.
   * If the service throws: let it propagate.
5.) End the span. Return 200 with the updated Letter entity.

// DELETE /letters/:grapheme
deleteLetter()
1.) Extract grapheme from the route param.
2.) Start a root span: startRootSpan('delete-letter-controller').
3.) Call letter.service.ts/delete() with { grapheme }.
   * If the service returns false: end the span, return 404.
   * If the service throws BadRequestException (FK constraint): end the span, return 409 with the error message.
   * If the service throws: let it propagate.
4.) End the span. Return 204 No Content.
