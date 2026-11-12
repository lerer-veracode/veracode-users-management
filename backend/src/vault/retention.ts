export const MAX_AGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const addDays = (from: Date, days: number): string =>
  new Date(from.getTime() + days * DAY_MS).toISOString();

export const isPast = (iso: string, now: Date): boolean => new Date(iso).getTime() <= now.getTime();

export const daysLeft = (iso: string, now: Date): number =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS));
