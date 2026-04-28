// Brand blue sampled from src/assets/branding/padhaipal-logo.svg (.st1).
export const BRAND_BLUE_HEX = '#1D9EDF';

export const REPORT_CARD_WIDTH = 1080;
export const REPORT_CARD_HEIGHT = 1350;

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

export const HINDI_TITLE = 'तुम्हारा रिपोर्ट कार्ड!';
export const HINDI_LETTERS_HEADING = 'सीखे हुए अक्षर';
export const HINDI_ACTIVITY_HEADING = 'पिछले 7 दिन';
export const HINDI_TRY_NOW = 'पढ़ाईपाल अभी आज़माएं!';

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
  letters_learnt: string[];
  letters_learnt_yesterday: string[];
  daily_bars: DailyBar[];
}