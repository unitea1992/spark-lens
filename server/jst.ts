// Times as the reports print them: Japan time, for agents and for people.

export function jst(ms: number | null): string | null {
  return ms === null ? null : `${new Date(ms + 9 * 3600_000).toISOString().slice(0, 19)}+09:00`;
}

/** "10/5(月) 08:46" in JST, for reasons read by people. */
export function jstShort(ms: number): string {
  const d = new Date(ms + 9 * 3600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${"日月火水木金土"[d.getUTCDay()]}) ${hm}`;
}
