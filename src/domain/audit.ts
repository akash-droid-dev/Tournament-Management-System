/**
 * Append-only audit log — design principle #4, §7.6.27.
 *
 * "Audit logs are append-only; no role, including Super Admin, can edit or
 * delete audit entries." That is enforced structurally: this class exposes no
 * update or delete, entries are frozen on write, and the array handed back by
 * `query()` is a copy.
 */

import type { AuditLogEntry, Role } from './types.ts';
import { newLogId, nowISO } from './ids.ts';

export interface AuditWrite {
  userId: string;
  userName: string;
  role: Role;
  tournamentId?: string;
  entityType: string;
  entityId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
  reasonCode?: string;
  device?: string;
}

export interface AuditQuery {
  tournamentId?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
}

/** Serialize a value for the old/new columns without losing structure. */
function ser(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export type AuditSink = (entry: AuditLogEntry) => void;

export class AuditLog {
  #entries: AuditLogEntry[] = [];
  #sinks: AuditSink[] = [];

  /** Mirror every entry to the platform audit store (§11 outbound). */
  addSink(sink: AuditSink): void {
    this.#sinks.push(sink);
  }

  record(w: AuditWrite): AuditLogEntry {
    const entry: AuditLogEntry = Object.freeze({
      logId: newLogId(),
      timestamp: nowISO(),
      userId: w.userId,
      userName: w.userName,
      role: w.role,
      tournamentId: w.tournamentId,
      entityType: w.entityType,
      entityId: w.entityId,
      action: w.action,
      oldValue: ser(w.oldValue),
      newValue: ser(w.newValue),
      reasonCode: w.reasonCode,
      device: w.device,
    });
    this.#entries.push(entry);
    for (const s of this.#sinks) s(entry);
    return entry;
  }

  /** §12.17 Audit Log Viewer — filterable, with before/after values. */
  query(q: AuditQuery = {}): AuditLogEntry[] {
    let out = this.#entries.filter((e) => {
      if (q.tournamentId && e.tournamentId !== q.tournamentId) return false;
      if (q.entityType && e.entityType !== q.entityType) return false;
      if (q.entityId && e.entityId !== q.entityId) return false;
      if (q.userId && e.userId !== q.userId) return false;
      if (q.action && e.action !== q.action) return false;
      if (q.from && e.timestamp < q.from) return false;
      if (q.to && e.timestamp > q.to) return false;
      return true;
    });
    out = out.slice().reverse(); // newest first
    return q.limit ? out.slice(0, q.limit) : out;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Load persisted entries at boot. Append-only: refuses to overwrite. */
  hydrate(entries: AuditLogEntry[]): void {
    if (this.#entries.length) {
      throw new Error('audit log already populated; hydrate() is boot-only (append-only store)');
    }
    this.#entries = entries.map((e) => Object.freeze({ ...e }));
  }
}

/** Process-wide audit log. The API server and engines share this instance. */
export const auditLog = new AuditLog();
