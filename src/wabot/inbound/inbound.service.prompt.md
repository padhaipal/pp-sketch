1.) If the message is type system ((Note that system messages are only used to communicate changes to the user’s phone number and nothing else. It is important not to miss these because if we do the user with the new phone number will look like a new user).
* Use the user phone number as an externalID to find and update the user in the database. Throw away the old user phone number. !!! I need to update the prompt for src/user/user.service.ts to support this, also see src/docs/database.md for notes !!!
  * See notes for information about the database fallback.
* If the user can’t be found in the database then log a WARN, return 404. 
* Else, then I have successfully updated the user entity in the database. End span. Return 2XX.
2.) Attempt to get the user’s data by hitting the database using the user’s phone number as the external_id.
* See notes for information about the database fallback and apply it to all the db calls in the steps below.
* If user doesn't exist in the database and the message is type text.
	* Search the text for valid phone numbers.
		* If there are any phone numbers that are different from the user than pick the first one. This is the referrer's phone number.
* If the user doesn't exist in the database.
	* Write one atomic db call to do the following. 
	  * Create the new user.
		* Find the user account associated with the referrer's phone number (if one exists).
		* Connect the two accounts in a referrer-referee relationship. 
  * If a new user was created then src/wabot/outbound/outbound.service.ts/sendWAMessage() with .env/WELCOME_MESSAGE_EXTERNAL_ID.
	  * See sendWAMessage() notes for how to handle the http response. 
  * End span.
* Else: I now have the existing user's information. 
3.) Check the timestamp on the message.
* If it is more than 20 seconds old then log a WARN, return 2XX and end the span. Note that wabot will handle sending the "please try again" message to the user.
4.) If the message is not type audio, reaction or text then. 
* src/wabot/outbound/outbound.service.ts/sendWAMessage() with .env/AUDIO_ONLY_REQUEST_EXTERNAL_ID.
  * See sendWAMessage() notes for how to handle the http response.
5.) (Note that now we should have the user entity data from the database and have screened out/handled all first time users and non-audio messages and so only have normal user interaction audio messages left.) Hit the src/mediaMetaData/mediaMetaData.service.ts/create() function. Look at src/mediaMetaData/mediaMetaData.dto.ts for how to structure the message. You will need the mediaUrl which can be obtained from payload.message.audio.mediaUrl as can be confirmed in src/wabot/inbound/wabot-inbound.dto.ts. 
6.) !!! I think I need to run the state machine. 




Note
* How to handle sendWAMessage() responses.  
  * If 2XX. Then log INFO and return 2XX. 
  * If 4XX. Then log ERROR and return 4XX. 
	* If 5XX. Then log WARN and return 5XX. 

Note
* database fallback
  * If redis is down then log a WARN and connect to the PG database directly.
    * If the PG database is down then log a WARN, return a 500 status to wabot.