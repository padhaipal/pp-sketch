// The morning report card (v2, 2026-10): one card about YESTERDAY — a big
// face and one line of praise in a header coloured by how the day went,
// a time tile and a level tile each with its own face, and the three
// letters practised most. Hindi only; no date, no QR, no logo.

export const REPORT_CARD_WIDTH = 1080;
export const REPORT_CARD_HEIGHT = 1350;

// A good day is five minutes of practice (USAGE_PASS_MINUTES, inclusive);
// any practice at all is an "ok" day; none is a poor one.
export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export type Band = 'good' | 'ok' | 'poor';

// Header / tile / face colour per band — the colour always matches the face.
export const BAND_COLOR_HEX: Record<Band, string> = {
  good: '#2E7D32',
  ok: '#C77C00',
  poor: '#C62828',
};
// Letter chips.
export const CHIP_NAVY_HEX = '#14306B';

export const HINDI_YESTERDAY = 'कल';
export const HINDI_MINUTES = 'मिनट';
export const HINDI_LEVELS = 'स्तर';

// Time band from yesterday's active milliseconds.
export function timeBand(activeMs: number): Band {
  if (activeMs >= FIVE_MINUTES_MS) return 'good';
  return activeMs > 0 ? 'ok' : 'poor';
}

// Level band from yesterday's change in lesson level.
export function levelBand(levelDelta: number): Band {
  if (levelDelta > 0) return 'good';
  return levelDelta === 0 ? 'ok' : 'poor';
}

// Whole minutes for the tile: some practice never rounds down to 0.
export function minutesOf(activeMs: number): number {
  if (activeMs <= 0) return 0;
  return Math.max(1, Math.round(activeMs / 60_000));
}

// One line of praise under the face, by the day's (time) band. Short,
// parent-facing, about yesterday ("कल") or what to do today ("आज"): the
// card goes out the morning after.
export const PRAISE_LINES: Record<Band, readonly string[]> = {
  good: [
    'कल बहुत बढ़िया काम!',
    'शाबाश! ऐसे ही पढ़ते रहो।',
    'आपका बच्चा खूब मेहनत कर रहा है।',
    'कमाल कर दिया!',
    'रोज़ की मेहनत रंग ला रही है।',
    'बहुत खूब! यही सही रास्ता है।',
    'आपका बच्चा आगे बढ़ रहा है।',
    'वाह! कल का दिन शानदार रहा।',
    'मेहनत का फल ज़रूर मिलेगा।',
    'कल पूरे मन से पढ़ा।',
    'आपका बच्चा तेज़ी से सीख रहा है।',
    'हर दिन थोड़ा-थोड़ा, यही जीत है।',
    'बढ़िया! आज भी ऐसा ही करें।',
    'गर्व करने लायक मेहनत!',
    'पढ़ने की आदत बन रही है।',
    'शानदार! पाँच मिनट पूरे हुए।',
    'बच्चा रोज़ बेहतर हो रहा है।',
    'इस लगन को बनाए रखें।',
    'खूब पढ़ा, खूब सीखा!',
    'आपकी मेहनत दिख रही है।',
  ],
  ok: [
    'अच्छी शुरुआत, थोड़ा और!',
    'कल थोड़ा पढ़ा, आज पाँच मिनट करें।',
    'हर मिनट मायने रखता है।',
    'बस थोड़ा और समय चाहिए।',
    'शुरू किया, यही बड़ी बात है।',
    'आज पाँच मिनट का लक्ष्य रखें।',
    'थोड़ा-थोड़ा रोज़ बहुत होता है।',
    'कल की कोशिश अच्छी थी।',
    'पाँच मिनट, बस इतना काफ़ी है।',
    'आज थोड़ा और पढ़ेंगे?',
    'सही दिशा में हैं, बढ़ते रहें।',
    'एक छोटा कदम और!',
    'आज पूरे पाँच मिनट आज़माएँ।',
    'अच्छा है, और बेहतर हो सकता है।',
    'कल से बेहतर, आज करें।',
    'रोज़ थोड़ा समय निकालें।',
    'शुरुआत हो गई, अब आगे बढ़ें।',
    'कोशिश जारी रखें।',
    'आज एक पाठ और पढ़ें।',
    'बच्चे के साथ पाँच मिनट बैठें।',
  ],
  poor: [
    'कल पढ़ाई छूट गई, आज करें।',
    'आज पाँच मिनट ज़रूर पढ़ें।',
    'बच्चा आपका इंतज़ार कर रहा है।',
    'आज फिर से शुरू करें।',
    'एक छोटी सी शुरुआत आज करें।',
    'कल नहीं हुआ, आज हो सकता है।',
    'रोज़ पाँच मिनट, बस इतना।',
    'आज एक पाठ ज़रूर पढ़ें।',
    'पढ़ाई को आज वापस लाएँ।',
    'आज थोड़ा समय निकालें।',
    'हर दिन मायने रखता है।',
    'आज की शुरुआत आपसे है।',
    'छूटा हुआ दिन आज पूरा करें।',
    'आज पाँच मिनट, कल से बेहतर।',
    'आज फिर कोशिश करें।',
    'पढ़ने की आदत आज से।',
    'आज एक कदम बढ़ाएँ।',
    'बच्चे के साथ आज पाँच मिनट।',
    'आज पढ़ाई का समय निकालें।',
    'आज एक नया अक्षर सीखें।',
  ],
};

// Stable within a day for a given child, different across days and
// children: a small string hash of the user id plus the day number.
export function pickPraise(
  band: Band,
  userId: string,
  dayNumber: number,
): string {
  const lines = PRAISE_LINES[band];
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return lines[(h + dayNumber) % lines.length];
}

export interface ReportCardData {
  user_external_id: string;
  // yesterday (IST)
  active_ms: number;
  minutes: number;
  time_band: Band;
  // last lesson level by end of yesterday minus the same by end of the day
  // before; 0 when either is unknown
  level_delta: number;
  level_band: Band;
  // up to three letters, most practised first
  top_letters: string[];
  praise: string;
}
