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
* Store the audio mediaMetaData entity's `id` as `userMessageId` — this will be passed to downstream services as the FK linking all writes back to this interaction.
6.) Call src/media-meta-data/media-meta-data.service.ts/findTranscripts() with:
  * media_metadata: the audio mediaMetaData entity from step 5 (trusted path — uses .id directly)
* If no transcripts are returned then log ERROR, end the span, fail the job.
* Else: continue
7.) Call src/literacy/literacy-lesson/literacy-lesson.service.ts/processAnswer() with:
  * user: the User entity from step 2 (trusted path, no extra DB hit)
  * transcripts: the transcript mediaMetaData entities obtained in step 6
  * user_message_id: the `userMessageId` from step 5
* processAnswer() internally handles: finding or creating the lesson state, rehydrating or starting a fresh machine, running the ANSWER event, and persisting the new snapshot. It returns `{ stateTransitionId, isComplete }`. Save the stateTransitionId in a variable.
* If processAnswer() throws then log ERROR, end the span and fail the job.
* If processAnswer() returns isComplete === true then call processAnswer() again with just user and user_message_id (omit transcripts — this starts a fresh lesson without sending an ANSWER event). This will return a second stateTransitionId, save it in a variable as well. 
8.) For each stateTransitionId (there may be one or two), call src/media-meta-data/media-meta-data.service.ts/findMediaByStateTransitionId().
  * Each call returns a `FindMediaByStateTransitionIdResult` with one randomly selected entity per media type (audio, video, text, image), or undefined for types with no matching media.
  * Build an ordered `OutboundMediaItem[]` array from the results. For each stateTransitionId's result, append items in this order: video, audio, image, text (skipping any type that is undefined). If there are two stateTransitionIds, the first stateTransitionId's items come before the second's.
  * For each media entity, construct the OutboundMediaItem:
    * `type: 'audio' | 'video' | 'image'` → `{ type, url: entity.s3_key or preloaded WhatsApp URL }`
    * `type: 'text'` → `{ type: 'text', body: entity.text }`
9.) Send the outbound message(s) to the student via src/interfaces/wabot/outbound/outbound.service.ts/sendMessage() with:
  * user_external_id: the User entity's external_id from step 2
  * wamid: payload.message.id
  * consecutive: payload.consecutive
  * media: the OutboundMediaItem[] array built in step 8
  * otel_carrier: the current span's carrier
Note that sendMessage() returns { status, body } where body has a `delivered` flag.
  * If 2XX and `delivered: true` then log INFO, end the span and mark the job as successful.
  * If 2XX and `delivered: false` then the inflight window expired and wabot already sent the fallback message. Roll back all writes associated with this interaction:
    3. Call `mediaMetaDataService.markRolledBack(userMessageId)` — sets `rolled_back = true` on the audio mediaMetaData entity, deleting any fk rows in the database that are associated with that userMessageId and preventing any late/out-of-order writes from referencing it.
    * Log INFO, end the span and mark the job as successful.
  * If 4XX then log ERROR, end the span and fail the job.
  * If 5XX then log ERROR, end the span and fail the job.

Note
* How to handle sendMessage() responses.  
  * If 2XX. Then log INFO, end the span and complete the job. 
  * If 4XX. Then log ERROR, end the span and fail the job. 
	* If 5XX. Then log WARN, end the span and fail the job. 
