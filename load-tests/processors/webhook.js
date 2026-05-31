// Artillery processor: builds a WhatsApp webhook payload for a load-test
// phone (LOAD_TEST_PHONE_PREFIX + random digits) and signs the exact bytes
// with META_APP_SECRET. The signed payload must match what
// wabot-sketch's AcceptService.isValidSignature() recomputes server-side,
// so we sign the same JSON string we send on the wire.

const crypto = require('node:crypto');

module.exports = { prepareWebhook };

function prepareWebhook(context, _events, next) {
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const prefix = process.env.LOAD_TEST_PHONE_PREFIX;
  const secret = process.env.META_APP_SECRET;

  if (!businessAccountId || !phoneNumberId || !prefix || !secret) {
    return next(
      new Error(
        'prepareWebhook: missing one of WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID, LOAD_TEST_PHONE_PREFIX, META_APP_SECRET',
      ),
    );
  }

  const phone =
    prefix +
    Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0');
  const wamid = `wamid.LOADTEST_${crypto.randomBytes(8).toString('hex')}`;
  const timestamp = Math.floor(Date.now() / 1_000).toString();

  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: businessAccountId,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '0000000000',
                phone_number_id: phoneNumberId,
              },
              contacts: [{ profile: { name: 'LoadTest' }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: wamid,
                  timestamp,
                  type: 'text',
                  text: { body: 'load test message' },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(payload);
  const signature =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(raw).digest('hex');

  context.vars.payload = raw;
  context.vars.signature = signature;
  return next();
}
