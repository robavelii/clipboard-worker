const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4 min ago", "3 h ago", "yesterday", "12 days ago", then the date. */
export function ago(at: number, now = Date.now()): string {
  const d = now - at;
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${Math.floor(d / MINUTE)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  if (d < 2 * DAY) return "yesterday";
  if (d < 30 * DAY) return `${Math.floor(d / DAY)} days ago`;
  return new Date(at).toLocaleDateString();
}

/** "expires in 6 days", "expires in 5 h", or null when it is far off or never. */
export function expiresIn(at: number | null, now = Date.now()): string | null {
  if (at === null) return null;
  const d = at - now;
  if (d > 8 * DAY) return null;
  if (d < HOUR) return "expires within the hour";
  if (d < DAY) return `expires in ${Math.floor(d / HOUR)} h`;
  const days = Math.floor(d / DAY);
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
