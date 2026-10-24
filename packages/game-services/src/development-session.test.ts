import assert from 'node:assert/strict';

import {
  createDevelopmentServerSession,
  developmentNotificationSessionPrefix,
  formatDevelopmentNotificationSessionAuthorization,
  parseDevelopmentNotificationSessionAuthorization,
  type DevelopmentServerSession,
} from './development-session.js';
import type { GameServicesNotificationIdentity } from './notifications/client.js';
import type { GameServicesHeaderResolver } from './request-headers.js';

// The header round-trips.
const session = { playerId: 'player_1', sessionId: 'dev-session', installationId: 'Device-2' };
const authorization = formatDevelopmentNotificationSessionAuthorization(session);
assert.equal(authorization, 'Bearer mpgd-dev.player_1.dev-session.Device-2');
assert.ok(authorization.startsWith(developmentNotificationSessionPrefix));
assert.deepEqual(parseDevelopmentNotificationSessionAuthorization(authorization), session);
const longest = 'a'.repeat(64);
assert.deepEqual(
  parseDevelopmentNotificationSessionAuthorization(
    `Bearer mpgd-dev.${longest}.${longest}.${longest}`,
  ),
  { playerId: longest, sessionId: longest, installationId: longest },
);

// Anything else is no session.
for (const malformed of [
  '',
  'mpgd-dev.p.s.i',
  'Bearer p.s.i',
  'bearer mpgd-dev.p.s.i',
  'Bearer  mpgd-dev.p.s.i',
  'Bearer mpgd-dev.p.s',
  'Bearer mpgd-dev.p.s.i.extra',
  'Bearer mpgd-dev..s.i',
  'Bearer mpgd-dev.p.s.',
  'Bearer mpgd-dev.p.s.i ',
  'Bearer mpgd-dev.p s.s.i',
  'Bearer mpgd-dev.p/1.s.i',
  'Bearer mpgd-dev.플레이어.s.i',
  `Bearer mpgd-dev.${'a'.repeat(65)}.s.i`,
  'Bearer mpgd-dev.p.s.i\n',
  'Bearer mpgd-dev.p%2E.s.i',
  'Basic mpgd-dev.p.s.i',
  'Bearer real-token',
]) {
  assert.equal(
    parseDevelopmentNotificationSessionAuthorization(malformed),
    undefined,
    JSON.stringify(malformed),
  );
}
assert.equal(parseDevelopmentNotificationSessionAuthorization(undefined), undefined);
assert.equal(
  parseDevelopmentNotificationSessionAuthorization(['Bearer mpgd-dev.p.s.i']),
  undefined,
);
for (const bad of [
  { ...session, playerId: '' },
  { ...session, sessionId: 'a.b' },
  { ...session, installationId: 'x'.repeat(65) },
]) {
  assert.throws(() => formatDevelopmentNotificationSessionAuthorization(bad), /1 to 64 letters/);
}

// A development server session: signed in from creation, with a fixed header.
const development = createDevelopmentServerSession({
  mode: 'development',
  playerId: 'player-1',
  installationId: 'device-1',
});
const identity: GameServicesNotificationIdentity = development;
const resolver: GameServicesHeaderResolver = development.getHeaders;
void resolver;
assert.deepEqual(identity.current(), { playerId: 'player-1', sessionId: 'dev-device-1' });
assert.deepEqual(development.getHeaders(), {
  authorization: 'Bearer mpgd-dev.player-1.dev-device-1.device-1',
});
let heard = 0;
const unsubscribe = identity.onAuthenticated(() => {
  heard += 1;
});
unsubscribe();
assert.equal(heard, 0);
const named: DevelopmentServerSession = createDevelopmentServerSession({
  mode: 'staging',
  playerId: 'player-1',
  installationId: 'device-1',
  sessionId: 'session-1',
});
assert.deepEqual(named.current(), { playerId: 'player-1', sessionId: 'session-1' });

// Never in a production build, and never with an id the Worker would refuse.
assert.throws(
  () => createDevelopmentServerSession({ mode: 'production', playerId: 'p', installationId: 'i' }),
  /refused in a production build/,
);
assert.throws(
  () =>
    createDevelopmentServerSession({ mode: 'development', playerId: 'p.q', installationId: 'i' }),
  /1 to 64 letters/,
);
assert.throws(
  () =>
    createDevelopmentServerSession({
      mode: 'development',
      playerId: 'p',
      installationId: 'i'.repeat(65),
    }),
  /1 to 64 letters/,
);
// A long installation id still gets a default session id, cut to the limit.
assert.deepEqual(
  createDevelopmentServerSession({ mode: 'development', playerId: 'p', installationId: 'i'.repeat(64) })
    .current(),
  { playerId: 'p', sessionId: `dev-${'i'.repeat(60)}` },
);

console.info('Development notification sessions passed.');
