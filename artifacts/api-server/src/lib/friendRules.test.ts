// Run: npx tsx --test src/lib/friendRules.test.ts   (from artifacts/api-server)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DECLINES, relationshipFor, decideSend, afterSend, afterDecline, canRespond, canCancel, canUnfriend,
  type PairRow,
} from './friendRules.js';

const A = 1, B = 2, C = 3;

/** Plays a send through the rules the way the route does, returning the new row and the decision. */
function send(row: PairRow | null, from: number, to: number) {
  const d = decideSend(row, from);
  return { decision: d, row: afterSend(row, from, to, d) };
}

test('first request inserts a pending row, seen as outgoing / incoming', () => {
  const { decision, row } = send(null, A, B);
  assert.deepEqual(decision, { action: 'insert' });
  assert.deepEqual(row, { requesterId: A, addresseeId: B, status: 'pending', declineCount: 0 });
  assert.equal(relationshipFor(row, A), 'outgoing');
  assert.equal(relationshipFor(row, B), 'incoming');
  assert.equal(relationshipFor(null, A), 'none');
});

test('re-sending while pending is unlimited and never changes who asked', () => {
  let row = send(null, A, B).row!;
  for (let i = 0; i < 10; i++) {
    const r = send(row, A, B);
    assert.deepEqual(r.decision, { action: 'refresh' });
    row = r.row!;
  }
  assert.deepEqual(row, { requesterId: A, addresseeId: B, status: 'pending', declineCount: 0 });
});

test('a reverse request while pending is acceptance', () => {
  const row = send(null, A, B).row!;
  const r = send(row, B, A);
  assert.deepEqual(r.decision, { action: 'accept' });
  assert.equal(r.row!.status, 'accepted');
  // Roles stay as they were: A asked, B accepted.
  assert.equal(r.row!.requesterId, A);
  assert.equal(relationshipFor(r.row, A), 'friends');
  assert.equal(relationshipFor(r.row, B), 'friends');
});

test('sending to a friend is a no-op', () => {
  const row: PairRow = { requesterId: A, addresseeId: B, status: 'accepted', declineCount: 1 };
  assert.deepEqual(decideSend(row, A), { action: 'already_friends' });
  assert.deepEqual(decideSend(row, B), { action: 'already_friends' });
});

test('3 declines in total, counting the first request, then the requester is locked out', () => {
  let row = send(null, A, B).row!;
  for (let n = 1; n <= MAX_DECLINES; n++) {
    assert.ok(canRespond(row, B));
    row = afterDecline(row);
    assert.equal(row.declineCount, n);
    if (n < MAX_DECLINES) {
      // Under the cap: A sees "none" (no "declined" wording) and may ask again → back to pending.
      assert.equal(relationshipFor(row, A), 'none');
      const r = send(row, A, B);
      assert.deepEqual(r.decision, { action: 'reopen', flip: false });
      assert.equal(r.row!.status, 'pending');
      assert.equal(r.row!.declineCount, n, 'reopening keeps the count');
      row = r.row!;
    }
  }
  assert.equal(relationshipFor(row, A), 'unavailable');
  assert.deepEqual(decideSend(row, A), { action: 'unavailable' });
  assert.deepEqual(decideSend(row, A), { action: 'unavailable' }, 'forever');
});

test('the decliner may always ask later: roles flip, history kept', () => {
  const declinedMax: PairRow = { requesterId: A, addresseeId: B, status: 'declined', declineCount: MAX_DECLINES };
  // B (who declined) sees no lock.
  assert.equal(relationshipFor(declinedMax, B), 'none');
  const r = send(declinedMax, B, A);
  assert.deepEqual(r.decision, { action: 'reopen', flip: true });
  assert.deepEqual(r.row, { requesterId: B, addresseeId: A, status: 'pending', declineCount: MAX_DECLINES });
  assert.equal(relationshipFor(r.row, A), 'incoming');
  // A can accept it, even though A could not have asked.
  assert.ok(canRespond(r.row, A));
  // If A declines B now, the pair is over the cap and B is the one locked out.
  const again = afterDecline(r.row!);
  assert.equal(relationshipFor(again, B), 'unavailable');
  assert.equal(relationshipFor(again, A), 'none');
});

test('who may respond, cancel and unfriend', () => {
  const pending: PairRow = { requesterId: A, addresseeId: B, status: 'pending', declineCount: 0 };
  assert.equal(canRespond(pending, B), true);
  assert.equal(canRespond(pending, A), false, 'the requester cannot accept their own request');
  assert.equal(canRespond(pending, C), false);
  assert.equal(canCancel(pending, A), true);
  assert.equal(canCancel(pending, B), false);
  assert.equal(canUnfriend(pending, A), false, 'a pending request is cancelled, not unfriended');

  const friends: PairRow = { ...pending, status: 'accepted' };
  assert.equal(canUnfriend(friends, A), true);
  assert.equal(canUnfriend(friends, B), true);
  assert.equal(canUnfriend(friends, C), false);
  assert.equal(canRespond(friends, B), false);
  assert.equal(canCancel(friends, A), false);

  const declined: PairRow = { ...pending, status: 'declined', declineCount: 1 };
  assert.equal(canRespond(declined, B), false);
  assert.equal(canCancel(declined, A), false);
  assert.equal(canRespond(null, B), false);
});
