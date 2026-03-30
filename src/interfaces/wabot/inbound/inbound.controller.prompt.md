receive()
1.) Check the http message data structure against src/interfaces/wabot/inbound/wabot-inbound.dto.ts. 
* If the check fails then return a 400 response. 
2.) Start a child span from the incoming carrier: `startChildSpan('wabot-inbound-controller', body.otel.carrier)`. See src/otel/otel.prompt.md for helpers.
3.) Inject the controller span's carrier into the job payload: replace `body.otel.carrier` with `injectCarrier(span)` so the processor creates a child of this span.
4.) Enqueue the job on the BullMQ `wabot-inbound` queue. 
* If enqueue fails log WARN and retry with exponential backoff and 10s time cap. 
  * If time cap is reached then log an ERROR, end the span and return a 500 response. 
* else continue 
5.) Return 202 response and end the span.
