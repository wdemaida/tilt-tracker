// Badges (feature/badges, phases 1–2). See src/lib/badges.ts, badgeMetrics.ts and badgeRules.ts.
//
//  badges              — one row per badge: kind metric | rule | manual, status draft | live | retired,
//                        optional 256x256 WebP image (bytea) with a never-reset image_version,
//                        availability window, activated_at (first go-live; forward-only rule badges
//                        count only scores posted after it)
//  user_badges         — PK (user_id, badge_id): a badge is earned once. Source columns: the score
//                        that completed a rule, the challenge that resolved it (phase 3), the admin
//                        who granted it; `note` is shown on the profile
//  user_metric_marks   — PK (user_id, metric, ref): event-sourced metrics (login days, friend
//                        requests) whose sources get deleted or purged elsewhere. COUNT(*) = value.
//
// Backfill: login_days from the user.signed_in events still in activity_events; the friend metrics
// from current friendships rows plus the friend.* events. Seeds the starter metric badges, all
// `draft` (Will takes them live from /admin/badges). The challenge-derived metrics are phase 3 — their
// seeded badges can't be activated until those metrics exist (activate answers metric_unavailable).
//
// Purely additive (IF NOT EXISTS / ON CONFLICT DO NOTHING everywhere) and idempotent — safe to re-run.
//
//   cd artifacts/api-server && npx tsx migrate23.ts

import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} }); // re-runs print "already exists" notices

await sql.begin(async tx => {
  await tx`
    CREATE TABLE IF NOT EXISTS badges (
      id              serial PRIMARY KEY,
      key             text NOT NULL UNIQUE,
      name            text NOT NULL,
      description     text NOT NULL DEFAULT '',
      icon            text NOT NULL DEFAULT 'award',
      color           varchar(7) NOT NULL DEFAULT '#f59e0b',
      image           bytea,
      image_version   integer NOT NULL DEFAULT 0,
      kind            text NOT NULL,
      metric          text,
      threshold       integer,
      rule            jsonb,
      retroactive     boolean NOT NULL DEFAULT false,
      status          text NOT NULL DEFAULT 'draft',
      available_from  timestamp,
      available_to    timestamp,
      activated_at    timestamp,
      sort_order      integer NOT NULL DEFAULT 0,
      created_by_id   integer REFERENCES users(id) ON DELETE SET NULL,
      created_at      timestamp NOT NULL DEFAULT now(),
      updated_at      timestamp NOT NULL DEFAULT now(),
      CONSTRAINT badges_kind_check CHECK (kind IN ('metric', 'rule', 'manual')),
      CONSTRAINT badges_status_check CHECK (status IN ('draft', 'live', 'retired')),
      CONSTRAINT badges_metric_check CHECK (kind <> 'metric' OR (metric IS NOT NULL AND threshold IS NOT NULL AND threshold >= 1)),
      CONSTRAINT badges_rule_check CHECK (kind <> 'rule' OR rule IS NOT NULL),
      CONSTRAINT badges_window_check CHECK (available_from IS NULL OR available_to IS NULL OR available_from <= available_to)
    )`;
  await tx`CREATE INDEX IF NOT EXISTS badges_status_idx ON badges (status)`;

  await tx`
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id             integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id            integer NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      earned_at           timestamp NOT NULL DEFAULT now(),
      source_score_id     integer REFERENCES scores(id) ON DELETE SET NULL,
      source_challenge_id integer REFERENCES challenges(id) ON DELETE SET NULL,
      granted_by_id       integer REFERENCES users(id) ON DELETE SET NULL,
      note                text,
      CONSTRAINT user_badges_pkey PRIMARY KEY (user_id, badge_id)
    )`;
  await tx`CREATE INDEX IF NOT EXISTS user_badges_badge_id_idx ON user_badges (badge_id)`;

  await tx`
    CREATE TABLE IF NOT EXISTS user_metric_marks (
      user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metric   text NOT NULL,
      ref      text NOT NULL,
      at       timestamp NOT NULL DEFAULT now(),
      CONSTRAINT user_metric_marks_pkey PRIMARY KEY (user_id, metric, ref)
    )`;
  await tx`CREATE INDEX IF NOT EXISTS user_metric_marks_metric_idx ON user_metric_marks (metric, user_id)`;

  // ── backfill ────────────────────────────────────────────────────────────────
  // login_days: one per America/New_York date. created_at is naive UTC.
  await tx`
    INSERT INTO user_metric_marks (user_id, metric, ref, at)
    SELECT actor_user_id, 'login_days',
           to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/New_York', 'YYYY-MM-DD'),
           min(created_at)
    FROM activity_events
    WHERE type = 'user.signed_in' AND actor_user_id IS NOT NULL
    GROUP BY 1, 3
    ON CONFLICT DO NOTHING`;

  // friend_requests_sent: every current row's requester did send one; plus the logged sends.
  await tx`
    INSERT INTO user_metric_marks (user_id, metric, ref, at)
    SELECT requester_id, 'friend_requests_sent', addressee_id::text, created_at FROM friendships
    UNION ALL
    SELECT actor_user_id, 'friend_requests_sent', subject_user_id::text, created_at FROM activity_events
    WHERE type IN ('friend.request_sent', 'friend.request_resent') AND actor_user_id IS NOT NULL AND subject_user_id IS NOT NULL
    ON CONFLICT DO NOTHING`;

  // Accepted: the addressee of an accepted row accepted the requester's request (a mutual ask
  // accepts without flipping the row). Plus logged accepts (actor = acceptor, subject = requester).
  await tx`
    WITH acc AS (
      SELECT addressee_id AS acceptor, requester_id AS requester, coalesce(responded_at, created_at) AS at
      FROM friendships WHERE status = 'accepted'
      UNION ALL
      SELECT actor_user_id, subject_user_id, created_at FROM activity_events
      WHERE type = 'friend.request_accepted' AND actor_user_id IS NOT NULL AND subject_user_id IS NOT NULL
    )
    INSERT INTO user_metric_marks (user_id, metric, ref, at)
    SELECT acceptor, 'friend_requests_accepted_by_you', requester::text, at FROM acc
    UNION ALL
    SELECT requester, 'your_requests_accepted', acceptor::text, at FROM acc
    ON CONFLICT DO NOTHING`;

  // Declined: ref = other user + ':' + the pair's decline number (what the live route writes — the
  // pair's decline_count after that decline). From the logged declines, numbered per pair in order;
  // a declined row with no logged decline (pre-log) contributes its latest one.
  await tx`
    WITH logged AS (
      SELECT actor_user_id AS decliner, subject_user_id AS requester, created_at AS at,
             row_number() OVER (PARTITION BY least(actor_user_id, subject_user_id), greatest(actor_user_id, subject_user_id) ORDER BY created_at, id) AS n
      FROM activity_events
      WHERE type = 'friend.request_declined' AND actor_user_id IS NOT NULL AND subject_user_id IS NOT NULL
    ),
    unlogged AS (
      SELECT f.addressee_id AS decliner, f.requester_id AS requester, coalesce(f.responded_at, f.created_at) AS at, f.decline_count AS n
      FROM friendships f
      WHERE f.status = 'declined' AND f.decline_count > 0 AND NOT EXISTS (
        SELECT 1 FROM logged l WHERE least(l.decliner, l.requester) = least(f.requester_id, f.addressee_id)
          AND greatest(l.decliner, l.requester) = greatest(f.requester_id, f.addressee_id))
    ),
    dec AS (SELECT * FROM logged UNION ALL SELECT * FROM unlogged)
    INSERT INTO user_metric_marks (user_id, metric, ref, at)
    SELECT decliner, 'friend_requests_declined_by_you', requester::text || ':' || n::text, at FROM dec
    UNION ALL
    SELECT requester, 'your_requests_declined', decliner::text || ':' || n::text, at FROM dec
    ON CONFLICT DO NOTHING`;

  // ── starter badges (all draft) ───────────────────────────────────────────────
  // [key, name, description, icon, color, metric, threshold]
  const seeds: Array<[string, string, string, string, string, string, number]> = [
    ['scores-1', 'First Ball', 'Posted your first score.', 'circle-dot', '#22c55e', 'scores_posted', 1],
    ['scores-10', 'Regular', 'Posted 10 scores.', 'list-checks', '#22c55e', 'scores_posted', 10],
    ['scores-100', 'Centurion', 'Posted 100 scores.', 'medal', '#f59e0b', 'scores_posted', 100],
    ['scores-1000', 'Wizard Mode', 'Posted 1,000 scores.', 'crown', '#a855f7', 'scores_posted', 1000],
    ['machines-10', 'Explorer', 'Played 10 different machines.', 'compass', '#0ea5e9', 'distinct_machines', 10],
    ['machines-50', 'Collector', 'Played 50 different machines.', 'library', '#0ea5e9', 'distinct_machines', 50],
    ['machines-100', 'No Machine Left Behind', 'Played 100 different machines.', 'gem', '#a855f7', 'distinct_machines', 100],
    ['venues-5', 'Road Trip', 'Posted scores at 5 venues.', 'map-pin', '#14b8a6', 'distinct_venues', 5],
    ['venues-25', 'Globetrotter', 'Posted scores at 25 venues.', 'globe', '#14b8a6', 'distinct_venues', 25],
    ['wins-1', 'First Win', 'Won your first challenge.', 'trophy', '#f59e0b', 'challenge_wins', 1],
    ['wins-5', 'Contender', 'Won 5 challenges.', 'trophy', '#f59e0b', 'challenge_wins', 5],
    ['wins-25', 'Champion', 'Won 25 challenges.', 'crown', '#f59e0b', 'challenge_wins', 25],
    ['losses-10', 'Good Sport', 'Lost 10 challenges and kept playing.', 'handshake', '#64748b', 'challenge_losses', 10],
    ['win-streak-3', 'Hot Streak', 'Won 3 challenges in a row.', 'flame', '#ef4444', 'win_streak_achieved', 3],
    ['win-streak-10', 'On Fire', 'Won 10 challenges in a row.', 'flame', '#ef4444', 'win_streak_achieved', 10],
    ['win-streak-25', 'Unstoppable', 'Won 25 challenges in a row.', 'zap', '#ef4444', 'win_streak_achieved', 25],
    ['loss-streak-3', 'Drain Monster', 'Lost 3 challenges in a row.', 'cloud-rain', '#64748b', 'loss_streak_achieved', 3],
    ['loss-streak-10', 'Persistence', 'Lost 10 challenges in a row — and came back.', 'cloud-rain', '#64748b', 'loss_streak_achieved', 10],
    ['loss-streak-25', 'Never Tilt', 'Lost 25 challenges in a row — and came back.', 'shield', '#64748b', 'loss_streak_achieved', 25],
    ['ties-1', 'Dead Even', 'Tied a challenge.', 'scale', '#0ea5e9', 'challenges_tied', 1],
    ['abandoned-5', 'Ball Save', 'Five challenges nobody finished.', 'hourglass', '#64748b', 'challenges_abandoned', 5],
    ['friend-request-1', 'Say Hi', 'Sent your first friend request.', 'user-plus', '#ec4899', 'friend_requests_sent', 1],
    ['friends-accepted-5', 'Crew', 'Accepted 5 friend requests.', 'users', '#ec4899', 'friend_requests_accepted_by_you', 5],
    ['logins-7', 'Week In', 'Signed in on 7 different days.', 'calendar-check', '#6366f1', 'login_days', 7],
    ['logins-30', 'Month In', 'Signed in on 30 different days.', 'calendar-check', '#6366f1', 'login_days', 30],
    ['logins-100', 'Lifer', 'Signed in on 100 different days.', 'calendar-heart', '#6366f1', 'login_days', 100],
  ];
  let order = 0;
  for (const [key, name, description, icon, color, metric, threshold] of seeds) {
    order += 10;
    await tx`
      INSERT INTO badges (key, name, description, icon, color, kind, metric, threshold, status, sort_order)
      VALUES (${key}, ${name}, ${description}, ${icon}, ${color}, 'metric', ${metric}, ${threshold}, 'draft', ${order})
      ON CONFLICT (key) DO NOTHING`;
  }
});

const [counts] = await sql`
  SELECT (SELECT count(*) FROM badges)::int AS badges,
         (SELECT count(*) FROM user_badges)::int AS awards,
         (SELECT count(*) FROM user_metric_marks)::int AS marks`;
console.log(`migrate23: badges, user_badges, user_metric_marks ready (${counts.badges} badges, ${counts.awards} awards, ${counts.marks} marks)`);
await sql.end();
