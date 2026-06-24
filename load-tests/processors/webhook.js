// Artillery processor for the staging post-merge load test.
//
// Each virtual user calls prepareWebhook() then 120s later
// prepareWebhookFollowUp() — the same phone is used twice so the second
// hit exercises the lesson-flow code path (a brand-new phone exercises
// onboarding). 120s is well above the inbound→outbound cycle time at
// sustained 5 rps, so wabot's consecutive-check key has cleared and the
// second message is NOT marked consecutive=true by pp-sketch.
//
// Payload bytes are signed with META_APP_SECRET so wabot's accept
// controller (AcceptService.isValidSignature) recomputes the same HMAC
// server-side.

const crypto = require('node:crypto');

module.exports = { prepareWebhook, prepareWebhookFollowUp };

function requireEnv() {
  const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const prefix = process.env.LOAD_TEST_PHONE_PREFIX;
  const secret = process.env.META_APP_SECRET;
  if (!businessAccountId || !phoneNumberId || !prefix || !secret) {
    throw new Error(
      'prepareWebhook: missing one of WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID, LOAD_TEST_PHONE_PREFIX, META_APP_SECRET',
    );
  }
  return { businessAccountId, phoneNumberId, prefix, secret };
}

function randomPhone(prefix) {
  return (
    prefix +
    Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, '0')
  );
}

function freshWamid() {
  return `wamid.LOADTEST_${crypto.randomBytes(8).toString('hex')}`;
}

function buildSignedPayload(opts) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: opts.businessAccountId,
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '0000000000',
                phone_number_id: opts.phoneNumberId,
              },
              contacts: [{ profile: { name: 'LoadTest' }, wa_id: opts.phone }],
              messages: [
                {
                  from: opts.phone,
                  id: opts.wamid,
                  timestamp: opts.timestamp,
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
    'sha256=' + crypto.createHmac('sha256', opts.secret).update(raw).digest('hex');
  return { raw, signature };
}

function prepareWebhook(context, _events, next) {
  let env;
  try {
    env = requireEnv();
  } catch (err) {
    return next(err);
  }

  const phone = randomPhone(env.prefix);
  const wamid = freshWamid();
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const { raw, signature } = buildSignedPayload({
    ...env,
    phone,
    wamid,
    timestamp,
  });

  // Stash the phone in context.vars so prepareWebhookFollowUp can reuse it.
  context.vars.phone = phone;
  context.vars.payload = raw;
  context.vars.signature = signature;
  return next();
}

function prepareWebhookFollowUp(context, _events, next) {
  let env;
  try {
    env = requireEnv();
  } catch (err) {
    return next(err);
  }

  const phone = context.vars.phone;
  if (typeof phone !== 'string' || phone.length === 0) {
    return next(
      new Error(
        'prepareWebhookFollowUp: context.vars.phone is missing — prepareWebhook must run first',
      ),
    );
  }

  // Fresh wamid + timestamp on every follow-up. Reusing the same wamid
  // would trip wabot's dedupe and drop the message before the lesson-flow
  // code path executes.
  const wamid = freshWamid();
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const { raw, signature } = buildSignedPayload({
    ...env,
    phone,
    wamid,
    timestamp,
  });

  context.vars.payload = raw;
  context.vars.signature = signature;
  return next();
}
