receiveWabot()
1.) Check the http message data structure against src/wabot/inbound/wabot-inbound.dto.ts. 
* If the check fails then return a 400 response. 
2.) Use the message payload to start a span.
3.) Call src/wabot/inbound/inbound.service.ts/receiveWabot(). 
4.) Return to wabot service the HTTP status that src/wabot/inbound/inbound.service.ts/receiveWabot() returns
5.) End the span. 
