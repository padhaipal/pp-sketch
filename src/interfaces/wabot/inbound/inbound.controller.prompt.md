receive()
1.) Check the http message data structure against src/interfaces/wabot/inbound/wabot-inbound.dto.ts. 
* If the check fails then return a 400 response. 
2.) Use the message payload to start a span. 
3.) Enqueue a job on the BullMQ `wabot-inbound` queue. 
* If enqueue fails log WARN and retry with exponential backoff and 10s time cap. 
  * If time cap is reached then log an ERROR and return a 500 response. 
* else continue 
4.) Return 202 response and end the span.
