/**
 * Store contract — the same assertions against both implementations.
 *
 * `TmsStoreLike` is the seam a host GMS replaces (docs/02-architecture.md), and
 * the browser build swaps SQLite for `MemoryStore`. A seam is only worth having
 * if both sides genuinely behave alike, so every test below runs twice: once
 * against node:sqlite, once against the Maps.
 *
 * The ordering tests look fussy but earn their place. Callers depend on
 * "newest first" for the audit log and on match-number order for a run sheet;
 * a store that returned insertion order would pass every functional test and
 * then print a fixture list in the wrong order on match day.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TmsStore } from '../src/store/db.ts';
import { MemoryStore } from '../src/store/memory.ts';
import type { TmsStoreLike } from '../src/store/store.ts';
import type { AuditLogEntry, NotificationEvent, StandingsRow } from '../src/domain/types.ts';
import { entry, event, format, match, result, tournament, user } from './helpers.ts';

const implementations: [string, () => TmsStoreLike][] = [
  ['TmsStore (node:sqlite)', () => new TmsStore(':memory:')],
  ['MemoryStore (maps)', () => new MemoryStore()],
];

const audit = (over: Partial<AuditLogEntry> = {}): AuditLogEntry => ({
  logId: 'LOG-000001',
  timestamp: '2026-03-10T09:00:00.000Z',
  userId: 'ta1',
  userName: 'R. Kulkarni',
  role: 'Tournament Admin',
  tournamentId: 'TRN-0001',
  entityType: 'match',
  entityId: 'MCH-0001',
  action: 'match.start',
  ...over,
});

const notification = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
  notificationId: 'NTF-000001',
  tournamentId: 'TRN-0001',
  type: 'schedule_published',
  audience: { roles: ['Team Manager'] },
  channels: ['app'],
  payload: {},
  sentAt: '2026-03-10T09:00:00.000Z',
  deliveryStatus: 'sent',
  ...over,
});

for (const [name, make] of implementations) {
  describe(`store contract — ${name}`, () => {
    let store: TmsStoreLike;
    const fresh = (): TmsStoreLike => (store = make());
    afterEach(() => store?.close());

    /**
     * A store with the parent rows already in place.
     *
     * The SQLite schema declares foreign keys, so an event needs its
     * tournament and a match needs its event before it can be written. Real
     * callers always work in that order — the service resolves the parent and
     * throws `not found` before it writes the child — so these tests do too.
     * The one place the two stores genuinely differ is pinned down in its own
     * test at the bottom of this file.
     */
    const seeded = (): TmsStoreLike => {
      const s = fresh();
      s.saveTournament(tournament({ tournamentId: 'TRN-0001', code: 'NKC-2026' }));
      s.saveTournament(tournament({ tournamentId: 'TRN-0002', code: 'OTHER-2027', startDate: '2027-01-05' }));
      s.saveEvent(event({ eventId: 'EVT-0001', tournamentId: 'TRN-0001' }));
      s.saveEvent(event({ eventId: 'EVT-0002', tournamentId: 'TRN-0001' }));
      s.saveEvent(event({ eventId: 'EVT-0009', tournamentId: 'TRN-0002' }));
      return s;
    };

    test('round-trips a tournament and reports its code', () => {
      const s = fresh();
      const t = tournament();
      s.saveTournament(t);
      assert.deepEqual(s.getTournament(t.tournamentId), t);
      assert.deepEqual(s.tournamentCodes(), [t.code]);
      assert.equal(s.getTournament('TRN-9999'), undefined);
    });

    test('a second save of the same id updates rather than duplicates', () => {
      const s = fresh();
      s.saveTournament(tournament({ name: 'First' }));
      s.saveTournament(tournament({ name: 'Second' }));
      assert.equal(s.listTournaments().length, 1);
      assert.equal(s.listTournaments()[0]?.name, 'Second');
    });

    test('lists tournaments newest first by start date', () => {
      const s = fresh();
      s.saveTournament(tournament({ tournamentId: 'TRN-0001', code: 'A', startDate: '2026-03-10' }));
      s.saveTournament(tournament({ tournamentId: 'TRN-0002', code: 'B', startDate: '2027-01-05' }));
      s.saveTournament(tournament({ tournamentId: 'TRN-0003', code: 'C', startDate: '2025-06-01' }));
      assert.deepEqual(
        s.listTournaments().map((t) => t.tournamentId),
        ['TRN-0002', 'TRN-0001', 'TRN-0003'],
      );
    });

    test('scopes events to their tournament, in id order', () => {
      const s = seeded();
      assert.deepEqual(
        s.listEvents('TRN-0001').map((e) => e.eventId),
        ['EVT-0001', 'EVT-0002'],
      );
      assert.deepEqual(s.listEvents('TRN-0002').map((e) => e.eventId), ['EVT-0009']);
      assert.deepEqual(s.listEvents('TRN-0404'), []);
    });

    test('finds a participant’s entries across a tournament’s events', () => {
      // §7.1.8 needs this to span events, and an Entry only knows its event —
      // so the store has to resolve the tournament through the event.
      const s = seeded();
      const a = entry(1, 'MH', undefined, { entryId: 'ENT-0001', eventId: 'EVT-0001' });
      const b = entry(1, 'MH', undefined, { entryId: 'ENT-0002', eventId: 'EVT-0002' });
      const other = entry(1, 'MH', undefined, { entryId: 'ENT-0003', eventId: 'EVT-0009' });
      for (const e of [a, b, other]) s.saveEntry(e);

      const found = s.listEntriesForParticipant('TRN-0001', a.participantRef.id);
      assert.deepEqual(
        found.map((e) => e.entryId).sort(),
        ['ENT-0001', 'ENT-0002'],
        'must find both events in this tournament and exclude the other tournament',
      );
    });

    test('returns the latest format for an event', () => {
      const s = seeded();
      s.saveFormat(format({ formatId: 'FMT-0001', eventId: 'EVT-0001' }));
      s.saveFormat(format({ formatId: 'FMT-0002', eventId: 'EVT-0001' }));
      assert.equal(s.getFormatForEvent('EVT-0001')?.formatId, 'FMT-0002');
    });

    test('lists fixtures in match-number order, not insertion order', () => {
      const s = seeded();
      s.saveMatches([
        match({ matchId: 'MCH-0003', matchNo: 'M03', eventId: 'EVT-0001' }),
        match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001' }),
        match({ matchId: 'MCH-0002', matchNo: 'M02', eventId: 'EVT-0001' }),
      ]);
      assert.deepEqual(
        s.listMatches('EVT-0001').map((m) => m.matchNo),
        ['M01', 'M02', 'M03'],
      );
      assert.equal(s.getMatchByNo('EVT-0001', 'M02')?.matchId, 'MCH-0002');
      assert.equal(s.getMatchByNo('EVT-0001', 'M99'), undefined);
    });

    test('orders a tournament’s fixtures by date then match number', () => {
      const s = seeded();
      s.saveMatches([
        match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001', scheduledDate: '2026-03-12' }),
        match({ matchId: 'MCH-0002', matchNo: 'M02', eventId: 'EVT-0001', scheduledDate: '2026-03-10' }),
        match({ matchId: 'MCH-0003', matchNo: 'M03', eventId: 'EVT-0001', scheduledDate: '2026-03-10' }),
      ]);
      assert.deepEqual(
        s.listMatchesForTournament('TRN-0001').map((m) => m.matchNo),
        ['M02', 'M03', 'M01'],
      );
      assert.deepEqual(
        s.listMatchesOnDate('TRN-0001', '2026-03-10').map((m) => m.matchNo),
        ['M02', 'M03'],
      );
    });

    test('keys a result by its match', () => {
      const s = seeded();
      s.saveMatch(match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001' }));
      const r = result({ resultId: 'RES-0001', matchId: 'MCH-0001', eventId: 'EVT-0001' });
      s.saveResult(r);
      assert.equal(s.getResultForMatch('MCH-0001')?.resultId, 'RES-0001');
      assert.equal(s.getResultForMatch('MCH-0404'), undefined);
      assert.equal(s.listResults('EVT-0001').length, 1);
    });

    test('upserts standings by event, group and participant', () => {
      const s = seeded();
      const row: StandingsRow = {
        eventId: 'EVT-0001',
        groupId: 'A',
        participantRef: 'ENT-0001',
        participantName: 'Maharashtra Women',
        unitId: 'MH',
        played: 1, won: 1, drawn: 0, lost: 0,
        points: 2, scoreFor: 30, scoreAgainst: 20,
        sportMetric: 10, sportMetricLabel: 'Score Diff',
        bonusPoints: 0, tiebreakNotes: [], rank: 1, qualificationFlag: '',
        computedAt: '2026-03-10T12:00:00.000Z',
      };
      s.saveStandings([row]);
      s.saveStandings([{ ...row, played: 2, points: 4 }]);
      const rows = s.listStandings('EVT-0001');
      assert.equal(rows.length, 1, 'same key must update, not append');
      assert.equal(rows[0]?.points, 4);
    });

    test('keeps the audit log append-only and newest first', () => {
      const s = fresh();
      s.appendAudit(audit({ logId: 'LOG-000001', timestamp: '2026-03-10T09:00:00.000Z' }));
      s.appendAudit(audit({ logId: 'LOG-000002', timestamp: '2026-03-10T10:00:00.000Z' }));
      s.appendAudit(audit({ logId: 'LOG-000003', timestamp: '2026-03-10T08:00:00.000Z' }));
      assert.deepEqual(
        s.queryAudit({}).map((e) => e.logId),
        ['LOG-000002', 'LOG-000001', 'LOG-000003'],
      );
      // There is deliberately no update or delete on the contract at all.
      assert.equal('updateAudit' in s, false);
      assert.equal('deleteAudit' in s, false);
    });

    test('filters the audit log by every documented facet', () => {
      const s = fresh();
      s.appendAudit(audit({ logId: 'LOG-000001', action: 'match.start', entityType: 'match' }));
      s.appendAudit(audit({ logId: 'LOG-000002', action: 'result.approve', entityType: 'result', entityId: 'RES-0001' }));
      s.appendAudit(audit({ logId: 'LOG-000003', action: 'result.approve', entityType: 'result', userId: 'sa1' }));
      assert.equal(s.queryAudit({ action: 'result.approve' }).length, 2);
      assert.equal(s.queryAudit({ entityType: 'match' }).length, 1);
      assert.equal(s.queryAudit({ entityId: 'RES-0001' }).length, 1);
      assert.equal(s.queryAudit({ userId: 'sa1' }).length, 1);
      assert.equal(s.queryAudit({ tournamentId: 'TRN-9999' }).length, 0);
      assert.equal(s.queryAudit({ limit: 2 }).length, 2);
    });

    test('reports the highest issued id suffix so counters resume', () => {
      const s = fresh();
      assert.equal(s.maxIdSuffix('audit_log', 'log_id'), 0);
      s.appendAudit(audit({ logId: 'LOG-000007' }));
      s.appendAudit(audit({ logId: 'LOG-000019' }));
      s.appendAudit(audit({ logId: 'LOG-000012' }));
      assert.equal(s.maxIdSuffix('audit_log', 'log_id'), 19);
      s.saveNotification(notification({ notificationId: 'NTF-000004' }));
      assert.equal(s.maxIdSuffix('notifications', 'notification_id'), 4);
    });

    test('refuses maxIdSuffix for any table outside the allow-list', () => {
      const s = fresh();
      // The SQL implementation interpolates the column name, so the allow-list
      // is the thing standing between it and an injection.
      assert.throws(() => s.maxIdSuffix('matches', 'match_id'), /not available/);
      assert.throws(() => s.maxIdSuffix('audit_log', 'doc'), /not available/);
    });

    test('lists notifications newest first, honouring the limit', () => {
      const s = fresh();
      s.saveNotification(notification({ notificationId: 'NTF-000001', sentAt: '2026-03-10T09:00:00.000Z' }));
      s.saveNotification(notification({ notificationId: 'NTF-000002', sentAt: '2026-03-10T11:00:00.000Z' }));
      s.saveNotification(notification({ notificationId: 'NTF-000003', sentAt: '2026-03-10T10:00:00.000Z' }));
      assert.deepEqual(
        s.listNotifications('TRN-0001').map((n) => n.notificationId),
        ['NTF-000002', 'NTF-000003', 'NTF-000001'],
      );
      assert.equal(s.listNotifications('TRN-0001', 2).length, 2);
      assert.equal(s.listNotifications('TRN-0404').length, 0);
    });

    test('defaults an unseen schedule to Draft rather than undefined', () => {
      const s = fresh();
      const st = s.getScheduleState('EVT-0001');
      assert.equal(st.status, 'Draft');
      assert.equal(st.versionNo, 1);
      assert.deepEqual(st.acknowledgedSoft, []);
      s.saveScheduleState({ ...st, status: 'Published', versionNo: 2, publishedAt: '2026-03-01T00:00:00.000Z' });
      assert.equal(s.getScheduleState('EVT-0001').status, 'Published');
      assert.equal(s.getScheduleState('EVT-0001').versionNo, 2);
    });

    test('commits a transaction that succeeds', () => {
      const s = fresh();
      s.transaction(() => {
        s.saveTournament(tournament());
        s.saveUser(user('ta1', 'Tournament Admin'));
      });
      assert.equal(s.listTournaments().length, 1);
      assert.equal(s.listUsers().length, 1);
    });

    test('rolls a failed transaction all the way back', () => {
      const s = fresh();
      s.saveTournament(tournament({ tournamentId: 'TRN-0001', code: 'KEEP' }));
      // The event below is the write that must disappear.
      assert.throws(() =>
        s.transaction(() => {
          s.saveEvent(event({ eventId: 'EVT-0001' }));
          s.saveUser(user('ta1', 'Tournament Admin'));
          throw new Error('workflow refused this');
        }),
      );
      assert.equal(s.listEvents('TRN-0001').length, 0, 'the event write must be undone');
      assert.equal(s.listUsers().length, 0, 'the user write must be undone too');
      assert.equal(s.getTournament('TRN-0001')?.code, 'KEEP', 'pre-existing data survives');
    });

    test('nested transactions commit once and roll back together', () => {
      const s = seeded();
      // saveMatches opens its own transaction; a service method that wraps it
      // in another must not deadlock or half-commit.
      s.transaction(() => {
        s.saveMatches([match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001' })]);
        s.saveTournament(tournament({ tournamentId: 'TRN-0003', code: 'THIRD' }));
      });
      assert.equal(s.listMatches('EVT-0001').length, 1);

      assert.throws(() =>
        s.transaction(() => {
          s.saveMatches([match({ matchId: 'MCH-0002', matchNo: 'M02', eventId: 'EVT-0001' })]);
          throw new Error('outer failure after an inner transaction');
        }),
      );
      assert.equal(
        s.listMatches('EVT-0001').length,
        1,
        'the inner write must roll back with the outer unit',
      );
    });

    test('reset empties every collection', () => {
      const s = seeded();
      s.saveMatch(match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001' }));
      s.appendAudit(audit());
      s.saveUser(user('ta1', 'Tournament Admin'));
      s.reset();
      assert.deepEqual(s.listTournaments(), []);
      assert.deepEqual(s.listEvents('TRN-0001'), []);
      assert.deepEqual(s.listMatches('EVT-0001'), []);
      assert.deepEqual(s.queryAudit({}), []);
      assert.deepEqual(s.listUsers(), []);
    });
  });
}

describe('MemoryStore serialisation', () => {
  test('survives a JSON round-trip with every collection intact', () => {
    // This is what the Pages build relies on: seed in Node, dump, hydrate in
    // the browser. A collection missed by toJSON/fromJSON would show up as a
    // mysteriously empty screen, so the test walks all of them.
    const s = new MemoryStore();
    s.saveTournament(tournament());
    s.saveEvent(event({ eventId: 'EVT-0001', tournamentId: 'TRN-0001' }));
    s.saveEntry(entry(1, 'MH', 1, { entryId: 'ENT-0001', eventId: 'EVT-0001' }));
    s.saveFormat(format({ formatId: 'FMT-0001', eventId: 'EVT-0001' }));
    s.saveMatch(match({ matchId: 'MCH-0001', matchNo: 'M01', eventId: 'EVT-0001' }));
    s.saveResult(result({ resultId: 'RES-0001', matchId: 'MCH-0001', eventId: 'EVT-0001' }));
    s.saveUser(user('ta1', 'Tournament Admin'));
    s.appendAudit(audit());
    s.saveNotification(notification());
    s.saveScheduleState({ eventId: 'EVT-0001', status: 'Published', acknowledgedSoft: ['REST_GAP'], versionNo: 3 });

    const revived = MemoryStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));

    assert.equal(revived.listTournaments().length, 1);
    assert.equal(revived.listEvents('TRN-0001').length, 1);
    assert.equal(revived.listEntries('EVT-0001').length, 1);
    assert.equal(revived.getFormatForEvent('EVT-0001')?.formatId, 'FMT-0001');
    assert.equal(revived.listMatches('EVT-0001').length, 1);
    assert.equal(revived.getResultForMatch('MCH-0001')?.resultId, 'RES-0001');
    assert.equal(revived.getUser('ta1')?.role, 'Tournament Admin');
    assert.equal(revived.queryAudit({}).length, 1);
    assert.equal(revived.listNotifications('TRN-0001').length, 1);
    assert.deepEqual(revived.getScheduleState('EVT-0001').acknowledgedSoft, ['REST_GAP']);
    assert.equal(revived.getScheduleState('EVT-0001').versionNo, 3);
  });

  test('a hydrated store keeps accepting writes', () => {
    // The Pages demo is not read-only: the browser writes on top of the
    // seeded snapshot, so hydration must not leave the store frozen.
    const s = new MemoryStore();
    s.saveTournament(tournament());
    const revived = MemoryStore.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    revived.saveEvent(event({ eventId: 'EVT-0001', tournamentId: 'TRN-0001' }));
    revived.appendAudit(audit({ logId: 'LOG-000002' }));
    assert.equal(revived.listEvents('TRN-0001').length, 1);
    assert.equal(revived.maxIdSuffix('audit_log', 'log_id'), 2);
  });
});

describe('where the two stores genuinely differ', () => {
  test('SQLite enforces foreign keys; MemoryStore does not', () => {
    // Found by writing the contract tests above: the SQLite schema declares
    // REFERENCES on events, entries, formats, matches, operations and
    // results, so an orphan child write is rejected. MemoryStore has no such
    // constraint.
    //
    // This is recorded rather than papered over, because it changes what a
    // bug looks like. In production an orphan write fails loudly at the
    // store; in the browser build it would succeed and surface later as a
    // screen that cannot resolve its parent.
    //
    // It is not a hole in the demo: the service layer resolves the parent and
    // throws `not found` before it ever writes the child (see `#event`,
    // `#match` and `#tournament` in src/api/service.ts), so the ordering is
    // already enforced a layer up. The second line of defence is simply
    // absent in the Maps.
    const sqlite = new TmsStore(':memory:');
    const memory = new MemoryStore();
    const orphan = event({ eventId: 'EVT-0001', tournamentId: 'TRN-NONE' });

    assert.throws(
      () => sqlite.saveEvent(orphan),
      /FOREIGN KEY/,
      'SQLite must reject an event whose tournament does not exist',
    );
    assert.doesNotThrow(
      () => memory.saveEvent(orphan),
      'MemoryStore accepts it — a known, accepted difference',
    );

    sqlite.close();
    memory.close();
  });
});
