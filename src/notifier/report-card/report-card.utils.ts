// IST = UTC+5:30 (no DST). Helpers for IST-anchored day boundaries.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// UTC instant of IST midnight on the IST date that contains `now`.
export function istMidnightUtc(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const istMidUtc = Date.UTC(
    ist.getUTCFullYear(),
    ist.getUTCMonth(),
    ist.getUTCDate(),
  );
  return new Date(istMidUtc - IST_OFFSET_MS);
}

// Add (signed) days to an IST midnight.
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

// JS weekday (0=Sun … 6=Sat) of the IST date corresponding to `instant`.
export function istWeekday(instant: Date): number {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  return ist.getUTCDay();
}

// YYYY-MM-DD of the IST date corresponding to `instant`.
export function istDateIso(instant: Date): string {
  const ist = new Date(instant.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
