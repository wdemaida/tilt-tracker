// How the /api/pinballmap routes answer the browser for each Pinball Map outcome. Pure (no DB, no
// network) so every branch is unit-tested against responses shaped exactly like PM's source — see
// the protocol note in pinballmapApi.ts. The routes only do the I/O.
import { PmApiError, isApiTokenRejection, type PmAuthResult, type PmSubmitResult } from './pinballmapApi.js';

export interface PmRouteReply {
  status: number;
  body: { error: string; code: string };
  /** Seconds for a Retry-After header, when PM told us (or our breaker knows) how long to wait. */
  retryAfterSec?: number;
  /** Wipe the user's stored PM token + email (the credential is dead; they must reconnect). */
  clearCredential?: boolean;
  /** Our own api_token was rejected — a config problem that breaks PM for every user. Log loudly. */
  ourTokenRejected?: boolean;
}

export const PM_RECONNECT_REQUIRED = 'pm_reconnect_required';

function busyMessage(retryAfterMs?: number): string {
  const mins = retryAfterMs ? Math.ceil(retryAfterMs / 60_000) : 1;
  return mins <= 1
    ? 'Pinball Map is busy, try again in a minute'
    : `Pinball Map is busy, try again in ${mins} minutes`;
}

/** A PmApiError from either call: never the user's fault, never clears their credential. */
export function pmErrorReply(err: PmApiError): PmRouteReply {
  if (isApiTokenRejection(err)) {
    return {
      status: 503,
      body: { error: 'Pinball Map connection problem on our side — please try again later', code: 'pm_api_token_rejected' },
      ourTokenRejected: true,
    };
  }
  const retryAfterSec = err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : undefined;
  if (err.kind === 'rate_limited') {
    return { status: 503, body: { error: busyMessage(err.retryAfterMs), code: 'pm_busy' }, retryAfterSec };
  }
  if (err.kind === 'unavailable' || err.kind === 'no_token' || err.kind === 'offline') {
    return { status: 503, body: { error: err.message, code: `pm_${err.kind}` }, retryAfterSec };
  }
  return {
    status: 502,
    body: { error: "Couldn't get a proper answer from Pinball Map — try again later", code: `pm_${err.kind}` },
    retryAfterSec,
  };
}

/** Reply for a failed connect (auth_details said no). */
export function authFailureReply(result: Extract<PmAuthResult, { ok: false }>): PmRouteReply {
  switch (result.reason) {
    case 'invalid_credentials':
      return { status: 401, body: { error: 'Invalid Pinball Map credentials', code: 'pm_invalid_credentials' } };
    case 'unconfirmed':
      return {
        status: 400,
        body: {
          error: `Your Pinball Map account isn't confirmed yet — open the confirmation email Pinball Map sent you, then try again. (Pinball Map says: "${result.message}")`,
          code: 'pm_unconfirmed',
        },
      };
    case 'missing_fields':
      return { status: 400, body: { error: 'Enter your Pinball Map username or email and your password', code: 'pm_missing_fields' } };
    case 'account_disabled':
      return {
        status: 403,
        body: { error: 'Pinball Map says this account is disabled — contact Pinball Map to sort it out', code: 'pm_account_disabled' },
      };
    default:
      return { status: 400, body: { error: `Pinball Map: ${result.message}`, code: 'pm_rejected' } };
  }
}

/** Reply for a score post PM refused. */
export function submitFailureReply(result: Extract<PmSubmitResult, { ok: false }>): PmRouteReply {
  switch (result.reason) {
    case 'auth_required':
      return {
        status: 401,
        body: { error: 'Your Pinball Map sign-in has expired — reconnect your Pinball Map account to post', code: PM_RECONNECT_REQUIRED },
        clearCredential: true,
      };
    case 'account_disabled':
      return {
        status: 403,
        body: { error: 'Pinball Map says this account is disabled — contact Pinball Map to sort it out', code: 'pm_account_disabled' },
      };
    default:
      return { status: 422, body: { error: `Pinball Map didn't accept the score: ${result.message}`, code: 'pm_rejected' } };
  }
}

/**
 * The stored credential needed to post, or the reply to send instead. A token with no email is a
 * connection made before migrate18 — it can never authenticate a write, so it's a reconnect too.
 */
export function storedPmAuth(user: { pinballMapToken?: string | null; pinballMapEmail?: string | null }):
  { ok: true; auth: { email: string; token: string } } | { ok: false; reply: PmRouteReply } {
  if (user.pinballMapToken && user.pinballMapEmail) {
    return { ok: true, auth: { email: user.pinballMapEmail, token: user.pinballMapToken } };
  }
  return {
    ok: false,
    reply: {
      status: 401,
      body: {
        error: user.pinballMapToken
          ? 'Reconnect your Pinball Map account to post (a one-time step after an update)'
          : 'Connect your Pinball Map account to post',
        code: PM_RECONNECT_REQUIRED,
      },
    },
  };
}

/** True when a stored connection can actually post — what GET /token reports as `hasToken`. */
export function hasUsablePmConnection(user: { pinballMapToken?: string | null; pinballMapEmail?: string | null }): boolean {
  return !!user.pinballMapToken && !!user.pinballMapEmail;
}
