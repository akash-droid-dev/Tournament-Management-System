/**
 * Identifier generation.
 *
 * IDs are readable on purpose: ops staff read them aloud over radio on match
 * day, and they appear on printed fixture sheets (§10 report 1).
 */

let counters: Record<string, number> = {};

/** `KAB-M-0007`-style sequential IDs, stable within a process. */
export function seq(prefix: string, width = 4): string {
  counters[prefix] = (counters[prefix] ?? 0) + 1;
  return `${prefix}-${String(counters[prefix]).padStart(width, '0')}`;
}

/** Reset sequence counters — used by tests and the seeder. */
export function resetSeq(): void {
  counters = {};
}

/** Restore counters so IDs keep climbing after a process restart. */
export function primeSeq(prefix: string, value: number): void {
  counters[prefix] = Math.max(counters[prefix] ?? 0, value);
}

/**
 * `globalThis.crypto` rather than `node:crypto`: it exists in Node 18+ and in
 * every browser, which keeps this module — and therefore the whole domain,
 * sport, engine and workflow layer — free of any platform import. That is what
 * lets the same rules run server-side and in a browser against an in-memory
 * store (see `src/store/memory.ts`).
 */
export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export const newTournamentId = (): string => seq('TRN');
export const newEventId = (): string => seq('EVT');
export const newEntryId = (): string => seq('ENT');
export const newMatchId = (): string => seq('MCH');
export const newResultId = (): string => seq('RES');
export const newDrawId = (): string => seq('DRW');
export const newFormatId = (): string => seq('FMT');
export const newAssignmentId = (): string => seq('ASG');
export const newProtestId = (): string => seq('PRT');
export const newExceptionId = (): string => seq('EXC');
export const newLogId = (): string => seq('LOG', 6);
export const newNotificationId = (): string => seq('NTF', 6);

/** Match numbers printed on fixture sheets: `M01`, `M02`, … per event. */
export function matchNo(n: number): string {
  return `M${String(n).padStart(2, '0')}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}
