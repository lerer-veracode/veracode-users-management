export const MAX_AGE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

export const daysLeft = (removesAt: string, now: Date): number =>
  Math.max(0, Math.ceil((new Date(removesAt).getTime() - now.getTime()) / DAY));
