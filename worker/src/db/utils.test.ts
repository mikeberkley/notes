import { describe, it, expect } from 'vitest';
import { daysAgo, isFriday, isLastFridayOfMonth } from './utils.js';

describe('daysAgo', () => {
  it('returns the correct date N days before', () => {
    expect(daysAgo(new Date('2026-04-16T00:00:00Z'), 0)).toBe('2026-04-16');
    expect(daysAgo(new Date('2026-04-16T00:00:00Z'), 1)).toBe('2026-04-15');
    expect(daysAgo(new Date('2026-04-16T00:00:00Z'), 6)).toBe('2026-04-10');
  });

  it('crosses month boundaries correctly', () => {
    expect(daysAgo(new Date('2026-04-01T00:00:00Z'), 1)).toBe('2026-03-31');
    expect(daysAgo(new Date('2026-03-01T00:00:00Z'), 1)).toBe('2026-02-28');
  });

  it('crosses year boundaries correctly', () => {
    expect(daysAgo(new Date('2026-01-01T00:00:00Z'), 1)).toBe('2025-12-31');
  });
});

describe('isFriday', () => {
  it('returns true for a Friday', () => {
    expect(isFriday(new Date('2026-04-17T00:00:00Z'))).toBe(true); // Friday
  });

  it('returns false for non-Friday days', () => {
    expect(isFriday(new Date('2026-04-16T00:00:00Z'))).toBe(false); // Thursday
    expect(isFriday(new Date('2026-04-18T00:00:00Z'))).toBe(false); // Saturday
    expect(isFriday(new Date('2026-04-13T00:00:00Z'))).toBe(false); // Monday
  });
});

describe('isLastFridayOfMonth', () => {
  it('returns true for the last Friday of a month', () => {
    // April 2026: Fridays are 3, 10, 17, 24 — last is April 24
    expect(isLastFridayOfMonth(new Date('2026-04-24T00:00:00Z'))).toBe(true);
    // March 2026: Fridays are 6, 13, 20, 27 — last is March 27
    expect(isLastFridayOfMonth(new Date('2026-03-27T00:00:00Z'))).toBe(true);
    // January 2026: Fridays are 2, 9, 16, 23, 30 — last is January 30
    expect(isLastFridayOfMonth(new Date('2026-01-30T00:00:00Z'))).toBe(true);
  });

  it('returns false for earlier Fridays in the same month', () => {
    expect(isLastFridayOfMonth(new Date('2026-04-17T00:00:00Z'))).toBe(false);
    expect(isLastFridayOfMonth(new Date('2026-04-10T00:00:00Z'))).toBe(false);
    expect(isLastFridayOfMonth(new Date('2026-04-03T00:00:00Z'))).toBe(false);
  });

  it('returns false for non-Friday dates even if at end of month', () => {
    expect(isLastFridayOfMonth(new Date('2026-04-30T00:00:00Z'))).toBe(false); // Thursday
    expect(isLastFridayOfMonth(new Date('2026-03-31T00:00:00Z'))).toBe(false); // Tuesday
  });

  it('handles a month where last Friday falls on the 31st', () => {
    // July 2026: Fridays are 3, 10, 17, 24, 31 — last is July 31
    expect(isLastFridayOfMonth(new Date('2026-07-31T00:00:00Z'))).toBe(true);
    expect(isLastFridayOfMonth(new Date('2026-07-24T00:00:00Z'))).toBe(false);
  });
});
