// pp-sketch/src/wabot/inbound/inbound.processor.prompt.md
Processes jobs from the `wabot-inbound` BullMQ queue. Job payload: src/wabot/inbound/wabot-inbound.dto.ts (MessageJobDto).

1.) If payload.message.type is "system" (Note that system messages are only used to communicate changes to the user's phone number and nothing else. It is important not to miss these because if we do the user with the new phone number will look like a new user).
* Use payload.message.from as the externalID to update the user in the database via users/user.service.ts/update().
* If the user can't be found in the database then log a ERROR, fail the job.
* Else, then I have successfully updated the user entity in the database. Log INFO. End span. Complete the job.
2.) Attempt user.service.ts/find() with payload.message.from as the externalID.
* If user doesn't exist in the database and payload.message.type is "text":
	* Search payload.message.text.body for valid phone numbers.
		* If there are any phone numbers that are different from payload.message.from then pick the first one. This is the referrer's phone number.
* If the user doesn't exist in the database:
  * user.service.ts/create() with payload.message.from as the externalID and the referrer's externalID as the phone number found in payload.message.text.body (if it exists). 
	  * If the referrer couldn't be identified in the database then log an INFO and move on. Don't let that block you.
	* If the new user failed to create then log ERROR and call src/wabot/outbound/outbound.service.ts/sendMessage() with .env/FALL_BACK_MESSAGE_EXTERNAL_ID.
	  * See sendMessage() notes below for how to handle the http response.
  * If a new user was created then src/wabot/outbound/outbound.service.ts/sendMessage() with .env/WELCOME_MESSAGE_EXTERNAL_ID.
	  * See sendMessage() notes below for how to handle the http response.
* Else: I now have the existing user's information and continue to the next step. 
3.) Check payload.message.timestamp.
* If it is more than 20 seconds old then log a WARN, complete the job and end the span. Note that wabot will handle sending the "please try again" message to the user.
4.) If payload.message.type is not "audio" then: 
* src/wabot/outbound/outbound.service.ts/sendMessage() with .env/AUDIO_ONLY_REQUEST_EXTERNAL_ID.
  * See sendMessage() notes below for how to handle the http response.
5.) (Note that now we should have the user entity data from the database and have screened out/handled all first time users and non-audio messages and so only have normal user interaction audio messages left.) Call src/media-meta-data/media-meta-data.service.ts/createWhatsappAudioMedia() with:
  * external_id: payload.message.audio.mediaUrl
  * source_url: payload.message.audio.mediaUrl
  * user: the User entity from step 2 (trusted path, no extra DB hit)
* This will return a mediaMetaData entity for the user's audio message which will contain a link to where that audio is stored in the S3 bucket. There will also be several mediaMetaData text entities associated with that mediaMetaData entity which will contain the transcripts of the audio message. 
6.) Hit the database for the transcript text mediaMetaData entities that are associated with that audio mediaMetaData entity. In the same hit also get the previous dehydrated literacy-lesson state for that user. 
7.) 
* If there is no literacy-lesson state then start a new lesson.
* If the literacy-lesson state is older than 60s then start a new lesson.
* Else rehydrate and run the literacy-lesson and pass in the transcript texts.
  * 

Note
* How to handle sendMessage() responses.  
  * If 2XX. Then log INFO, end the span and complete the job. 
  * If 4XX. Then log ERROR, end the span and fail the job. 
	* If 5XX. Then log WARN, end the span and fail the job. 
