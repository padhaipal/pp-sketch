import {
  buildReportCardSvg,
  CHIP_Y,
  escapeXml,
  formatLevelDelta,
  HEADER_HEIGHT,
  renderChips,
  renderFace,
} from './report-card.svg';
import {
  BAND_COLOR_HEX,
  CHIP_NAVY_HEX,
  REPORT_CARD_HEIGHT,
  REPORT_CARD_WIDTH,
  ReportCardData,
} from './report-card.dto';

const data = (over: Partial<ReportCardData> = {}): ReportCardData => ({
  user_external_id: '918888888001',
  active_ms: 18 * 60_000,
  minutes: 18,
  time_band: 'good',
  level_delta: 2,
  level_band: 'good',
  top_letters: ['क', 'म', 'त'],
  praise: 'कल बहुत बढ़िया काम!',
  ...over,
});

describe('buildReportCardSvg', () => {
  it('is a 1080 × 1350 SVG with a white page and a header in the time band colour, the word कल and the praise line', () => {
    const svg = buildReportCardSvg(data());
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain(
      `width="${REPORT_CARD_WIDTH}" height="${REPORT_CARD_HEIGHT}" viewBox="0 0 ${REPORT_CARD_WIDTH} ${REPORT_CARD_HEIGHT}"`,
    );
    expect(svg).toContain(
      `width="${REPORT_CARD_WIDTH}" height="${REPORT_CARD_HEIGHT}" fill="#FFFFFF"`,
    );
    expect(svg).toContain(
      `height="${HEADER_HEIGHT}" fill="${BAND_COLOR_HEX.good}" data-header="good"`,
    );
    expect(svg).toContain('>कल</text>');
    expect(svg).toContain('data-praise="1">कल बहुत बढ़िया काम!</text>');
    // no date, no QR, no logo, no referral
    expect(svg).not.toMatch(
      /<image|<svg[^>]*viewBox="103 275|dashboard\.padhaipal\.com|\d{4}-\d{2}-\d{2}/,
    );
    expect(svg).not.toContain(data().user_external_id);
  });

  it('the header colour follows the TIME band alone; each tile carries its own band and face', () => {
    const svg = buildReportCardSvg(
      data({
        time_band: 'poor',
        minutes: 0,
        active_ms: 0,
        level_band: 'good',
        level_delta: 1,
      }),
    );
    expect(svg).toContain(`fill="${BAND_COLOR_HEX.poor}" data-header="poor"`);
    expect(svg).toContain('data-tile="time" data-band="poor"');
    expect(svg).toContain('data-tile="level" data-band="good"');
    // the big header face is sad, the level tile's face is happy
    const header = svg.slice(0, svg.indexOf('data-tile="time"'));
    expect(header).toContain('data-face="poor"');
    const level = svg.slice(svg.indexOf('data-tile="level"'));
    expect(level).toContain('data-face="good"');
  });

  it('time tile: the minutes and मिनट; level tile: a signed delta and स्तर with an up / flat / down icon', () => {
    const up = buildReportCardSvg(data());
    expect(up).toContain(
      '>18</tspan><tspan dx="18" font-size="44" font-weight="400" fill="#555555">मिनट</tspan>',
    );
    expect(up).toContain(
      '>+2</tspan><tspan dx="18" font-size="44" font-weight="400" fill="#555555">स्तर</tspan>',
    );
    expect(up).toContain('data-level-icon="up"');
    const flat = buildReportCardSvg(data({ level_delta: 0, level_band: 'ok' }));
    expect(flat).toContain('>0</tspan>');
    expect(flat).toContain('data-level-icon="flat"');
    expect(flat).toContain('data-tile="level" data-band="ok"');
    const down = buildReportCardSvg(
      data({ level_delta: -1, level_band: 'poor' }),
    );
    expect(down).toContain('>-1</tspan>');
    expect(down).toContain('data-level-icon="down"');
  });

  it('draws one navy chip per letter (at most three), centred; none when there are no letters', () => {
    const three = buildReportCardSvg(data());
    expect(three.match(/data-chip=/g)).toHaveLength(3);
    expect(three).toContain(`fill="${CHIP_NAVY_HEX}" data-chip="क"`);
    expect(three).toContain('>क</text>');
    const one = renderChips(['ख']);
    expect(one).toContain(`x="${(REPORT_CARD_WIDTH - 150) / 2}" y="${CHIP_Y}"`);
    expect(renderChips([])).toBe('');
    expect(buildReportCardSvg(data({ top_letters: [] }))).not.toContain(
      'data-chip=',
    );
    expect(
      buildReportCardSvg(data({ top_letters: ['क', 'म', 'त', 'ल'] })).match(
        /data-chip=/g,
      ),
    ).toHaveLength(3);
  });

  it('faces: a smile curves down past the mouth line, a frown up, a flat mouth is a straight line', () => {
    const smile = renderFace({
      cx: 100,
      cy: 100,
      r: 50,
      band: 'good',
      fill: '#fff',
      ink: '#000',
    });
    const flat = renderFace({
      cx: 100,
      cy: 100,
      r: 50,
      band: 'ok',
      fill: '#fff',
      ink: '#000',
    });
    const frown = renderFace({
      cx: 100,
      cy: 100,
      r: 50,
      band: 'poor',
      fill: '#fff',
      ink: '#000',
    });
    expect(smile).toMatch(/<path d="M74,111 Q100,136 126,111"/);
    expect(flat).toMatch(/<path d="M74,117 L126,117"/);
    expect(frown).toMatch(/<path d="M74,126 Q100,96 126,126"/);
    for (const f of [smile, flat, frown])
      expect(f.match(/<circle/g)).toHaveLength(3); // disc + two eyes
  });

  it('escapes XML in text and formats level deltas with an explicit plus', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;');
    expect(buildReportCardSvg(data({ praise: 'A & B' }))).toContain(
      '>A &amp; B</text>',
    );
    expect(formatLevelDelta(3)).toBe('+3');
    expect(formatLevelDelta(0)).toBe('0');
    expect(formatLevelDelta(-2)).toBe('-2');
  });
});
