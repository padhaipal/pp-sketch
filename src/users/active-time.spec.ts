import {
  ACTIVE_GAP_THRESHOLD_MS,
  ACTIVITY_EVENT_SQL,
  COUNTED_GAP_SQL,
  INTERACTION_MEDIA_SQL,
  IS_TAP_SQL,
  TAP_ACTIVE_GAP_THRESHOLD_MS,
  activeMs,
} from './active-time';

const voice = (at: number) => ({ at, tap: false });
const tap = (at: number) => ({ at, tap: true });

describe('activeMs', () => {
  it('allowances: 120 s ending in a voice note, 4 min 58 s ending in a tap', () => {
    expect(ACTIVE_GAP_THRESHOLD_MS).toBe(120_000);
    expect(TAP_ACTIVE_GAP_THRESHOLD_MS).toBe(298_000);
  });

  it('no events or a single event is no time', () => {
    expect(activeMs([])).toBe(0);
    expect(activeMs([voice(1_000)])).toBe(0);
    expect(activeMs([tap(1_000)])).toBe(0);
  });

  it('counts a voice→voice gap strictly under 120 s', () => {
    expect(activeMs([voice(0), voice(119_999)])).toBe(119_999);
    expect(activeMs([voice(0), voice(120_000)])).toBe(0);
  });

  it('counts a gap ending in a tap strictly under 298 s, whatever started it', () => {
    expect(activeMs([voice(0), tap(297_999)])).toBe(297_999);
    expect(activeMs([tap(0), tap(297_999)])).toBe(297_999);
    expect(activeMs([voice(0), tap(298_000)])).toBe(0);
  });

  it('the allowance belongs to the event that ENDS the gap', () => {
    // tap → voice 200 s later: a voice note closes it, 120 s allowance → break
    expect(activeMs([tap(0), voice(200_000)])).toBe(0);
    // voice → tap 200 s later: counted
    expect(activeMs([voice(0), tap(200_000)])).toBe(200_000);
  });

  it('a tap-only lesson run accrues its reading time', () => {
    // three taps 3 min apart: two counted gaps
    expect(activeMs([tap(0), tap(180_000), tap(360_000)])).toBe(360_000);
  });

  it('duplicate timestamps add nothing', () => {
    expect(activeMs([voice(5), voice(5), tap(5)])).toBe(0);
  });
});

describe('active-time SQL fragments', () => {
  it('interactions = whatsapp voice notes + nfm_reply text rows', () => {
    expect(INTERACTION_MEDIA_SQL()).toBe(
      "source = 'whatsapp' AND (media_type = 'audio' OR (media_type = 'text' AND media_details->>'nfm_reply' = 'true'))",
    );
    expect(INTERACTION_MEDIA_SQL('mm')).toBe(
      "mm.source = 'whatsapp' AND (mm.media_type = 'audio' OR (mm.media_type = 'text' AND mm.media_details->>'nfm_reply' = 'true'))",
    );
  });

  it('activity events add the rolled_back visibility filter', () => {
    expect(ACTIVITY_EVENT_SQL()).toBe(
      `${INTERACTION_MEDIA_SQL()} AND rolled_back = false`,
    );
    expect(ACTIVITY_EVENT_SQL('m')).toBe(
      `${INTERACTION_MEDIA_SQL('m')} AND m.rolled_back = false`,
    );
  });

  it('tap flag and counted-gap test mirror activeMs', () => {
    expect(IS_TAP_SQL()).toBe("(media_type = 'text')");
    expect(IS_TAP_SQL('mm')).toBe("(mm.media_type = 'text')");
    expect(COUNTED_GAP_SQL('g', 't')).toBe(
      'g > 0 AND g < CASE WHEN t THEN 298000 ELSE 120000 END',
    );
  });
});
