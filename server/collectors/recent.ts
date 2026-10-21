/** Samples kept for the on-screen sparklines: ten minutes at the default 5-second poll. */
export const RECENT_POINTS = 120;

/** Append a sample, dropping the oldest beyond `RECENT_POINTS`. */
export function pushRecent<T>(arr: T[], value: T): void {
  arr.push(value);
  if (arr.length > RECENT_POINTS) arr.splice(0, arr.length - RECENT_POINTS);
}
