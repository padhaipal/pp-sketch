import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RecordReferralClickDto } from './referral-click.dto';

function errors(body: object): string[] {
  return validateSync(plainToInstance(RecordReferralClickDto, body)).map(
    (e) => e.property,
  );
}

const HASH = 'c'.repeat(64);

describe('RecordReferralClickDto', () => {
  it('accepts a phone-number referrer and a hex hash', () => {
    expect(errors({ referrer: '919565897842', visitor_hash: HASH })).toEqual(
      [],
    );
  });

  it.each(['', 'abc', '91956589784212345', '12345'])(
    'rejects referrer %p',
    (referrer) => {
      expect(errors({ referrer, visitor_hash: HASH })).toEqual(['referrer']);
    },
  );

  it.each(['', 'z'.repeat(64), 'a'.repeat(63), 'A'.repeat(64)])(
    'rejects visitor_hash %p',
    (visitor_hash) => {
      expect(errors({ referrer: '919565897842', visitor_hash })).toEqual([
        'visitor_hash',
      ]);
    },
  );
});
