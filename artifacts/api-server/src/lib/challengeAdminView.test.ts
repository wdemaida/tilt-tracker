// Run: DATABASE_URL=postgres://x:x@localhost:1/x npx tsx --test src/lib/challengeAdminView.test.ts   (from artifacts/api-server)
//
// The admin's read-only challenge view (GET /api/admin/challenges/:id, fix/admin-challenge-view):
// buildView() with no viewer must give the same challenge, standings and counting scores a
// participant gets, with nothing the observer could act on — and a participant's view must be
// unchanged (no adminView key, the same `me`). Pure: rows in, view out; the DB is never dialled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildView, OBSERVER_ME, type ChallengeRow, type ParticipantRow } from './challenges.js';

const H = 60 * 60 * 1000;
const NOW = new Date('2026-10-01T12:00:00Z');
const A = 1, B = 2, C = 3;

function user(id: number) {
  return { id, username: `u${id}`, displayName: `U${id}`, role: 'user' };
}
function part(id: number, response: ParticipantRow['response'], extra: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    userId: id, response, declineReason: null, outcome: null, baselineScore: null, resultValue: null, rank: null,
    respondedAt: new Date(+NOW - 10 * H), user: user(id), ...extra,
  };
}
function challenge(extra: Partial<ChallengeRow> = {}): ChallengeRow {
  return {
    id: 7, type: 'high_score', status: 'active', matchMode: 'exact', matchGroup: null, machineId: 5, venueId: null,
    targetScore: null, minPlays: null, startsAt: new Date(+NOW - 5 * H), endsAt: new Date(+NOW + 48 * H),
    createdAt: new Date(+NOW - 12 * H), resolvedAt: null, creatorId: A, counteredFromId: null, proposedById: null, void: false,
    machine: { id: 5, name: 'Munsters (Pro)', imageUrl: null, opdbId: null },
    venue: null,
    ...extra,
  } as unknown as ChallengeRow;
}
function score(id: number, userId: number, value: number) {
  return {
    id, userId, machineId: 5, opdbId: null, venueId: null, venueName: null, venueTimezone: null, score: value,
    playedAt: new Date(+NOW - 2 * H), createdAt: new Date(+NOW - 2 * H + 60_000),
    hasPhoto: true, hasFullPhoto: false, hasThumbnail: true, visibleToOthers: true,
  };
}
const extras = { counteredToId: null, proposals: [] };

test('admin observer: same challenge and standings, no me, no opponent, nothing to act on', () => {
  const c = challenge();
  const parts = [part(A, 'accepted'), part(B, 'accepted')];
  const cands = [score(11, A, 1_000_000), score(12, B, 2_000_000)];
  const asA = buildView(c, parts, cands, A, NOW, true, extras);
  const asAdmin = buildView(c, parts, cands, null, NOW, true, extras);

  assert.equal(asAdmin.adminView, true);
  assert.deepEqual(asAdmin.me, OBSERVER_ME);
  for (const [k, v] of Object.entries(asAdmin.me)) if (k.startsWith('can')) assert.equal(v, false, `${k} is false`);
  assert.equal(asAdmin.opponent, null);
  // Everything that isn't about the viewer is identical to what a participant sees.
  const { me: _m1, opponent: _o1, adminView: _a1, ...restAdmin } = asAdmin;
  const { me: _m2, opponent: _o2, ...restA } = asA;
  assert.deepEqual(restAdmin, restA);
  assert.equal(asAdmin.participants.find(p => p.user.id === B)?.standing?.liveRank, 1);
  assert.deepEqual(asAdmin.participants.map(p => p.scores?.map(s => s.id)), [[11], [12]]);
});

test('participant views are unchanged: no adminView key, me computed as before', () => {
  const c = challenge();
  const parts = [part(A, 'accepted'), part(B, 'accepted')];
  const asB = buildView(c, parts, [], B, NOW, true, extras);
  assert.equal('adminView' in asB, false, 'participants never get the key');
  assert.equal(asB.me.response, 'accepted');
  assert.equal(asB.me.canForfeit, true);
  assert.equal(asB.opponent?.id, A);
});

test('admin observer gets no actions in any state a participant could act in', () => {
  const pending = challenge({ status: 'pending', startsAt: null });
  const parts = [part(A, 'accepted'), part(B, 'accepted'), part(C, 'pending')];
  const asCreator = buildView(pending, parts, [], A, NOW, false, extras);
  assert.equal(asCreator.me.canCancel, true, 'the challenger could cancel');
  assert.equal(asCreator.me.canStart, true, 'the challenger could start with who is in');
  const asInvitee = buildView(pending, parts, [], C, NOW, false, extras);
  assert.equal(asInvitee.me.canAccept, true);
  assert.equal(asInvitee.me.canDecline, true);
  assert.deepEqual(buildView(pending, parts, [], null, NOW, false, extras).me, OBSERVER_ME);

  const proposal = challenge({ status: 'proposed', startsAt: null, proposedById: B, counteredFromId: 3 } as Partial<ChallengeRow>);
  const pParts = [part(B, 'accepted'), part(A, 'pending')];
  assert.equal(buildView(proposal, pParts, [], A, NOW, false, extras).me.canDecideProposal, true, 'the challenger decides a proposal');
  const adminP = buildView(proposal, pParts, [], null, NOW, false, extras);
  assert.deepEqual(adminP.me, OBSERVER_ME);
  assert.equal(adminP.proposedBy?.id, B, 'whose suggestion it is still shows');
});

