// Brand blue sampled from src/assets/branding/padhaipal-logo.svg (.st1).
export const BRAND_BLUE_HEX = '#1D9EDF';

// Light wash for the "letters learnt" section background.
export const LETTERS_SECTION_BG_HEX = '#EAF6FC';

export const REPORT_CARD_WIDTH = 1080;
// Canvas height is computed dynamically per-render — letters section grows
// or shrinks with the letter count, so a fixed cap would either truncate or
// leave dead space.

// Days are listed Monday → Sunday for the chart, but the actual labelling is
// keyed off each rendered bar's IST weekday.
export const HINDI_WEEKDAY_SHORT: Record<number, string> = {
  0: 'रवि',
  1: 'सोम',
  2: 'मंगल',
  3: 'बुध',
  4: 'गुरु',
  5: 'शुक्र',
  6: 'शनि',
};

export const HINDI_TITLE = 'आपका दैनिक रिपोर्ट कार्ड!';
export const HINDI_LETTERS_HEADING = 'सीखे हुए अक्षर';
export const HINDI_CURRENTLY_LEARNING_HEADING =
  'तुम्हारा बच्चा जो अक्षर अभी सीख रहा है';
export const HINDI_ALREADY_KNOWN_HEADING = 'तुम्हारे बच्चे को पहले से आते अक्षर';
export const HINDI_ACTIVITY_HEADING = 'पिछले 7 दिन';
export const HINDI_TRY_NOW = 'पढ़ाईपाल अभी शेयर करें।';

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

// Per-day bar built by the report-card service. day_index is the JS weekday
// (0 = Sunday … 6 = Saturday) of the IST date the bar represents. The bars
// are rendered in chronological order, oldest first.
export interface DailyBar {
  date_iso: string;
  day_index: number;
  active_ms: number;
}

export interface ReportCardData {
  user_external_id: string;
  // Public referral URL the QR code on the card encodes —
  // `https://dashboard.padhaipal.com/r/{user_external_id}`. pp-dashboard
  // 302-redirects that path to the wa.me referral link.
  referral_url: string;
  // Bin 3 (mastered) — displayed in the "सीखे हुए अक्षर" subsection.
  letters_learnt: string[];
  // Subset of letters_learnt earned during yesterday's IST date — these are
  // highlighted with a star inside the सीखे हुए अक्षर grid.
  letters_learnt_yesterday: string[];
  // Bin 2 (regressed) — displayed in the "अभी सीख रहा है" subsection.
  letters_currently_learning: string[];
  // Bin 4 (improved without a qualifying dip) — displayed in the
  // "पहले से आते अक्षर" subsection.
  letters_already_known: string[];
  daily_bars: DailyBar[];
}