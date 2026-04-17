export function randomUUID(): string {
  return crypto.randomUUID();
}

export function hashKey(key: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then(buf =>
    Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
  );
}

/** Generate a cryptographically random API key (32 bytes, hex-encoded) */
export function generateRawApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** YYYY-MM-DD of today in UTC */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD, N days before the given date */
export function daysAgo(date: Date, n: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** True if the given UTC date is a Friday */
export function isFriday(date: Date): boolean {
  return date.getUTCDay() === 5;
}

/** True if the given UTC date is the last Friday of its month */
export function isLastFridayOfMonth(date: Date): boolean {
  if (!isFriday(date)) return false;
  const nextWeek = new Date(date);
  nextWeek.setUTCDate(date.getUTCDate() + 7);
  return nextWeek.getUTCMonth() !== date.getUTCMonth();
}
