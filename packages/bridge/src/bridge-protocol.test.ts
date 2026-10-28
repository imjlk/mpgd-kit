import {
  assertCommerceBridgeFetchProductsPayload,
  assertCommerceBridgeFinishTransactionPayload,
  assertCommerceBridgeFinishTransactionResult,
  assertCommerceBridgeGetAvailablePurchasesPayload,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeGetCapabilitiesPayload,
  assertCommerceBridgeRequestPurchasePayload,
  assertCommerceBridgeRequestPurchaseResult,
  assertCommerceBridgeRestorePurchasesPayload,
  assertCommerceEventEnvelope,
  assertCommercePresentationEventEnvelope,
  commerceBridgeMethods,
  commercePresentationProtocol,
  commerceProtocol,
  type CommerceEvent,
  type CommercePresentationEvent,
} from '@mpgd/platform/commerce';
import {
  assertNotificationEventEnvelope,
  notificationBackendBridgeMethods,
  notificationBridgeMethods,
  notificationsProtocol,
  type NotificationEvent,
} from '@mpgd/platform/notifications';

import {
  invalidBridgeEvents,
  invalidBridgeRequests,
  invalidNotificationsV2Payloads,
  invalidNotificationsV2Results,
  notificationsV2ScheduleLocalPayload,
  notificationsV2UnknownZoneEndpointChanged,
  validBridgeErrorResponse,
  validBridgeEvents,
  validBridgeOkResponse,
  validBridgeRequest,
  validCommerceV2BridgeRequests,
  validCommerceV2BridgeResponses,
  validNewBridgeRequests,
  validNotificationsV2BridgeRequests,
  validNotificationsV2Exchanges,
} from './fixtures';
import {
  assertBridgeEvent,
  assertBridgeRequest,
  assertBridgeResponse,
  bridgeCommerceEventProtocol,
  bridgeCommercePresentationEventProtocol,
  bridgeCommerceV2Methods,
  bridgeEventProtocol,
  bridgeNotificationsBackendMethods,
  bridgeNotificationsEventProtocol,
  bridgeNotificationsV2Methods,
  bridgeStorageLoadProtocol,
  commerceV2UnavailableBridgeErrorCode,
  createBridgeError,
  createBridgeEventSource,
  createCommerceV2UnavailableBridgeError,
  createNotificationsBackendUnavailableBridgeError,
  createNotificationsV2UnavailableBridgeError,
  decodeBridgeStorageLoadData,
  isBridgeCommerceV2Method,
  isBridgeNotificationsBackendMethod,
  isBridgeNotificationsV2Method,
  notificationsV2UnavailableBridgeErrorCode,
  type BridgeEvent,
  type BridgeEventOf,
  type BridgeEventProtocol,
  type BridgeEventSource,
  type BridgeMethod,
  type BridgeNotificationsV2Method,
} from './index';
import {
  assertBridgeNotificationsBackendPayload,
  assertBridgeNotificationsBackendResult,
  assertBridgeNotificationsV2Payload,
  assertBridgeNotificationsV2Result,
  type BridgeNotificationsV2Payload,
  type BridgeNotificationsV2Result,
} from './notifications';

assertDoesNotThrow(() => assertBridgeRequest(validBridgeRequest), 'valid request should pass');
assertDoesNotThrow(() => assertBridgeResponse(validBridgeOkResponse), 'ok response should pass');
assertDoesNotThrow(
  () => assertBridgeResponse(validBridgeErrorResponse),
  'error response should pass',
);

for (const validRequest of validNewBridgeRequests) {
  assertDoesNotThrow(
    () => assertBridgeRequest(validRequest),
    `${validRequest.method} request should pass`,
  );
}

for (const invalidRequest of invalidBridgeRequests) {
  assertThrows(() => assertBridgeRequest(invalidRequest), 'invalid request should fail');
}

// Commerce v2: the bridge method list is the platform contract's list.
const expectedCommerceV2Methods: readonly BridgeMethod[] = [
  'commerce.v2.getCapabilities',
  'commerce.v2.fetchProducts',
  'commerce.v2.requestPurchase',
  'commerce.v2.getAvailablePurchases',
  'commerce.v2.finishTransaction',
  'commerce.v2.restorePurchases',
];
assertEqual(
  JSON.stringify(bridgeCommerceV2Methods),
  JSON.stringify(expectedCommerceV2Methods),
  'bridge commerce v2 methods should be the six RFC methods',
);
assertEqual(
  JSON.stringify(bridgeCommerceV2Methods),
  JSON.stringify(commerceBridgeMethods),
  'bridge commerce v2 methods should equal @mpgd/platform/commerce commerceBridgeMethods',
);
for (const method of commerceBridgeMethods) {
  assertEqual(isBridgeCommerceV2Method(method), true, `${method} should be a v2 method`);
}
// The v1 commerce methods were removed in C4: they are neither v2 methods nor bridge methods.
for (const removed of [
  'commerce.getProducts',
  'commerce.purchase',
  'commerce.restore',
  'commerce.getEntitlements',
]) {
  assertEqual(isBridgeCommerceV2Method(removed), false, `${removed} was removed in C4`);
  assertThrows(
    () => assertBridgeRequest({ ...validCommerceV2BridgeRequests[0], method: removed }),
    `${removed} is no longer a bridge method`,
  );
}
assertEqual(isBridgeCommerceV2Method('commerce.v2.unknown'), false, 'unknown v2 names fail closed');
assertEqual(
  validCommerceV2BridgeRequests.length,
  commerceBridgeMethods.length,
  'every v2 method should have a request fixture',
);

const commerceV2PayloadAsserts = {
  'commerce.v2.getCapabilities': assertCommerceBridgeGetCapabilitiesPayload,
  'commerce.v2.fetchProducts': assertCommerceBridgeFetchProductsPayload,
  'commerce.v2.requestPurchase': assertCommerceBridgeRequestPurchasePayload,
  'commerce.v2.getAvailablePurchases': assertCommerceBridgeGetAvailablePurchasesPayload,
  'commerce.v2.finishTransaction': assertCommerceBridgeFinishTransactionPayload,
  'commerce.v2.restorePurchases': assertCommerceBridgeRestorePurchasesPayload,
} as const satisfies Record<(typeof commerceBridgeMethods)[number], (input: unknown) => unknown>;

for (const request of validCommerceV2BridgeRequests) {
  assertDoesNotThrow(() => assertBridgeRequest(request), `${request.method} request should pass`);
  const assertPayload = isBridgeCommerceV2Method(request.method)
    ? commerceV2PayloadAsserts[request.method]
    : undefined;
  if (assertPayload === undefined) {
    throw new Error(`${request.method} should be a commerce v2 method.`);
  }
  assertDoesNotThrow(
    () => assertPayload(request.payload),
    `${request.method} payload should satisfy the platform contract`,
  );
}

const commerceV2ResultAsserts: readonly ((input: unknown) => unknown)[] = [
  assertCommerceBridgeRequestPurchaseResult,
  assertCommerceBridgeGetAvailablePurchasesResult,
  assertCommerceBridgeFinishTransactionResult,
];
for (const [index, response] of validCommerceV2BridgeResponses.entries()) {
  assertDoesNotThrow(() => assertBridgeResponse(response), `${response.id} response should pass`);
  const assertResult = commerceV2ResultAsserts[index];
  if (assertResult === undefined || !response.ok) {
    throw new Error(`${response.id} should have an ok result assert.`);
  }
  assertDoesNotThrow(
    () => assertResult(response.data),
    `${response.id} data should satisfy the platform contract`,
  );
}

const unavailable = createCommerceV2UnavailableBridgeError(
  { id: 'v2-request', method: 'commerce.v2.requestPurchase' },
  'Test transport',
);
assertEqual(unavailable.ok, false, 'a v2 request without a provider should fail');
if (!unavailable.ok) {
  assertEqual(unavailable.error.code, commerceV2UnavailableBridgeErrorCode, 'v2 unavailable code');
  assertEqual(unavailable.error.code, 'COMMERCE_V2_UNAVAILABLE', 'v2 unavailable literal');
  assertEqual(unavailable.error.retryable, false, 'v2 unavailable should not be retryable');
  assertEqual(
    unavailable.error.message.includes('commerce.v2.requestPurchase'),
    true,
    'v2 unavailable message should name the method',
  );
}
assertDoesNotThrow(() => assertBridgeResponse(unavailable), 'v2 unavailable response should pass');

// Notifications v2: the bridge method list is the platform contract's list.
const expectedNotificationsV2Methods: readonly BridgeMethod[] = [
  'notifications.v2.getCapabilities',
  'notifications.v2.getPermission',
  'notifications.v2.requestPermission',
  'notifications.v2.revokePermission',
  'notifications.v2.register',
  'notifications.v2.scheduleLocal',
  'notifications.v2.cancelLocal',
  'notifications.v2.listLocal',
  'notifications.v2.openSettings',
];
assertEqual(
  JSON.stringify(bridgeNotificationsV2Methods),
  JSON.stringify(expectedNotificationsV2Methods),
  'bridge notifications v2 methods should be the nine RFC methods',
);
assertEqual(
  JSON.stringify(bridgeNotificationsV2Methods),
  JSON.stringify(notificationBridgeMethods),
  'bridge notifications v2 methods should equal @mpgd/platform/notifications notificationBridgeMethods',
);
for (const method of notificationBridgeMethods) {
  assertEqual(isBridgeNotificationsV2Method(method), true, `${method} should be a v2 method`);
  assertEqual(isBridgeCommerceV2Method(method), false, `${method} is not a commerce method`);
}
assertEqual(
  isBridgeNotificationsV2Method('notifications.requestSubscription'),
  false,
  'v1 notification methods are not v2',
);
assertEqual(
  isBridgeNotificationsV2Method('notifications.v2.unknown'),
  false,
  'unknown notifications v2 names fail closed',
);
assertEqual(
  isBridgeNotificationsV2Method('commerce.v2.getCapabilities'),
  false,
  'commerce v2 methods are not notifications methods',
);
assertEqual(
  JSON.stringify(validNotificationsV2Exchanges.map(({ method }) => method)),
  JSON.stringify(notificationBridgeMethods),
  'every notifications v2 method should have one exchange fixture',
);
for (const request of validNotificationsV2BridgeRequests) {
  assertDoesNotThrow(() => assertBridgeRequest(request), `${request.method} request should pass`);
}

// Each method's payload and answer go through that method's platform validator.
for (const { method, payload, result } of validNotificationsV2Exchanges) {
  assertDoesNotThrow(
    () => assertBridgeNotificationsV2Payload(method, payload),
    `${method} payload should satisfy the platform contract`,
  );
  assertDoesNotThrow(
    () => assertBridgeNotificationsV2Payload(method, JSON.parse(JSON.stringify(payload))),
    `${method} payload should survive a JSON round trip`,
  );
  const response = { id: `notifications-${method}`, ok: true, data: result } as const;
  assertDoesNotThrow(() => assertBridgeResponse(response), `${method} response should pass`);
  assertDoesNotThrow(
    () => assertBridgeNotificationsV2Result(method, JSON.parse(JSON.stringify(result))),
    `${method} result should satisfy the platform contract`,
  );
}
for (const method of notificationBridgeMethods) {
  for (const [index, payload] of invalidNotificationsV2Payloads[method].entries()) {
    assertThrows(
      () => assertBridgeNotificationsV2Payload(method, payload),
      `${method} invalid payload ${String(index)} should fail`,
    );
  }
  for (const [index, data] of invalidNotificationsV2Results[method].entries()) {
    assertThrows(
      () => assertBridgeNotificationsV2Result(method, data),
      `${method} invalid result ${String(index)} should fail`,
    );
  }
  // A payload is checked against its own method, not any method's shape.
  if (method !== 'notifications.v2.scheduleLocal') {
    assertThrows(
      () => assertBridgeNotificationsV2Payload(method, notificationsV2ScheduleLocalPayload),
      `${method} should reject another method's payload`,
    );
  }
}
const typed: { readonly topics: readonly string[] } = assertBridgeNotificationsV2Payload(
  'notifications.v2.requestPermission',
  { topics: ['energy-full'] },
);
assertEqual(typed.topics[0], 'energy-full', 'a validated payload should keep its typed shape');
// The subpath also names the shapes its validators return.
const typedThroughSubpath: BridgeNotificationsV2Payload<'notifications.v2.requestPermission'> =
  typed;
const answeredThroughSubpath: BridgeNotificationsV2Result<'notifications.v2.openSettings'> =
  assertBridgeNotificationsV2Result('notifications.v2.openSettings', { status: 'opened' });
assertEqual(typedThroughSubpath.topics.length, 1, 'the subpath payload type fits the payload');
assertEqual(answeredThroughSubpath.status, 'opened', 'the subpath result type fits the answer');
for (const method of [
  'constructor',
  'toString',
  'commerce.v2.getCapabilities',
  'notifications.v2',
]) {
  assertThrows(
    () => assertBridgeNotificationsV2Payload(method as BridgeNotificationsV2Method, {}),
    `${method} should not reach a payload validator`,
  );
  assertThrows(
    () => assertBridgeNotificationsV2Result(method as BridgeNotificationsV2Method, {}),
    `${method} should not reach a result validator`,
  );
}

for (const method of bridgeNotificationsV2Methods) {
  const answer = createNotificationsV2UnavailableBridgeError(
    { id: `notifications-${method}`, method },
    'Test transport',
  );
  assertDoesNotThrow(
    () => assertBridgeResponse(answer),
    `${method} unavailable response should pass`,
  );
  if (answer.ok) {
    throw new Error(`${method} without v2 should fail.`);
  }
  assertEqual(answer.id, `notifications-${method}`, `${method} unavailable answer keeps the id`);
  assertEqual(
    answer.error.code,
    notificationsV2UnavailableBridgeErrorCode,
    `${method} unavailable code`,
  );
  assertEqual(answer.error.code, 'NOTIFICATIONS_V2_UNAVAILABLE', `${method} unavailable literal`);
  assertEqual(answer.error.retryable, false, `${method} unavailable should not be retryable`);
  assertEqual(
    answer.error.message.includes(method) && answer.error.message.includes('Test transport'),
    true,
    `${method} unavailable message should name the method and the transport`,
  );
}

// Events: one channel, envelopes told apart by protocol.
assertEqual(
  bridgeEventProtocol,
  commerceProtocol,
  'the deprecated bridge event protocol stays the commerce protocol',
);
assertEqual(bridgeEventProtocol, 'mpgd.commerce.v2', 'bridge event protocol literal');
assertEqual(bridgeCommerceEventProtocol, commerceProtocol, 'commerce event protocol');
assertEqual(
  bridgeNotificationsEventProtocol,
  notificationsProtocol,
  'notifications event protocol',
);
assertEqual(
  bridgeNotificationsEventProtocol,
  'mpgd.notifications.v2',
  'notifications event protocol literal',
);
const protocolsSeen = new Set<string>();
for (const event of validBridgeEvents) {
  assertDoesNotThrow(
    () => assertBridgeEvent(event),
    `${'type' in event.event ? event.event.type : event.event.state} event should pass`,
  );
  protocolsSeen.add(event.protocol);
  if (event.protocol === commerceProtocol) {
    assertDoesNotThrow(
      () => assertCommerceEventEnvelope(event),
      `${event.event.type} event should satisfy the commerce envelope`,
    );
    assertThrows(
      () => assertNotificationEventEnvelope(event),
      `${event.event.type} commerce event is not a notifications envelope`,
    );
    assertThrows(
      () => assertCommercePresentationEventEnvelope(event),
      `${event.event.type} commerce event is not a presentation envelope`,
    );
  } else if (event.protocol === commercePresentationProtocol) {
    assertDoesNotThrow(
      () => assertCommercePresentationEventEnvelope(event),
      `${event.event.state} fact should satisfy the presentation envelope`,
    );
    assertThrows(
      () => assertCommerceEventEnvelope(event),
      `${event.event.state} presentation fact is not a commerce envelope`,
    );
  } else {
    assertDoesNotThrow(
      () => assertNotificationEventEnvelope(event),
      `${event.event.type} event should satisfy the notifications envelope`,
    );
    assertThrows(
      () => assertCommerceEventEnvelope(event),
      `${event.event.type} notifications event is not a commerce envelope`,
    );
  }
  const roundTripped = assertBridgeEvent(JSON.parse(JSON.stringify(event)));
  assertEqual(roundTripped.protocol, event.protocol, 'events should survive a JSON round trip');
}
assertEqual(protocolsSeen.size, 3, 'the fixtures should cover every protocol');
for (const [index, event] of invalidBridgeEvents.entries()) {
  assertThrows(() => assertBridgeEvent(event), `invalid event ${String(index)} should fail`);
}

// The union narrows on `protocol`, so a listener reaches each stream's own events.
const notificationTypes: NotificationEvent['type'][] = [];
const commerceTypes: CommerceEvent['type'][] = [];
const presentationStates: CommercePresentationEvent['state'][] = [];
for (const event of validBridgeEvents as readonly BridgeEvent[]) {
  if (event.protocol === bridgeNotificationsEventProtocol) {
    notificationTypes.push(event.event.type);
  } else if (event.protocol === bridgeCommercePresentationEventProtocol) {
    presentationStates.push(event.event.state);
  } else {
    commerceTypes.push(event.event.type);
  }
}
assertEqual(
  JSON.stringify(presentationStates),
  JSON.stringify(['open', 'closed', 'not-started', 'closed']),
  'presentation envelopes should narrow to presentation facts',
);
assertEqual(
  bridgeCommercePresentationEventProtocol,
  'mpgd.commerce.presentation.v1',
  'presentation event protocol literal',
);
assertEqual(
  JSON.stringify(notificationTypes),
  JSON.stringify(['opened', 'received', 'endpoint-changed', 'permission-changed']),
  'notifications envelopes should narrow to notification events',
);
assertEqual(
  JSON.stringify(commerceTypes),
  JSON.stringify(['purchaseUpdated', 'purchaseError', 'subscriptionUpdated']),
  'commerce envelopes should narrow to commerce events',
);
const openedOf: BridgeEventOf<'mpgd.notifications.v2'> = {
  type: 'opened',
  channel: 'local',
  source: 'warm',
};
const purchaseOf: BridgeEventOf<'mpgd.commerce.v2'> = {
  type: 'purchaseError',
  error: { code: 'NETWORK', retryable: true },
};
void openedOf;
void purchaseOf;

// A host session numbers each protocol's events from 0.
function createFakeStream<TEvent>(options: { readonly liveIteration?: boolean } = {}) {
  const subscribers = new Set<(event: TEvent) => void>();
  const buffered: TEvent[] = [];
  let subscribeCalls = 0;
  let subscribedOnce = false;
  return {
    get subscribeCalls() {
      return subscribeCalls;
    },
    get subscriberCount() {
      return subscribers.size;
    },
    emit(event: TEvent) {
      // Like a provider (`NotificationProvider`): events before the first
      // subscriber wait for it; later events reach only current subscribers.
      if (!subscribedOnce) {
        buffered.push(event);
        return;
      }
      // A provider may walk its live set, which also reaches a subscriber
      // added during this emit.
      for (const subscriber of options.liveIteration === true ? subscribers : [...subscribers]) {
        subscriber(event);
      }
    },
    subscribe(listener: (event: TEvent) => void) {
      subscribeCalls += 1;
      subscribedOnce = true;
      subscribers.add(listener);
      for (const event of buffered.splice(0)) {
        listener(event);
      }
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}

const opened: NotificationEvent = {
  type: 'opened',
  channel: 'local',
  source: 'cold',
  topic: 'energy-full',
};
const received: NotificationEvent = { type: 'received', channel: 'remote', topic: 'energy-full' };
const stream = createFakeStream<NotificationEvent>();
// A cold-start open emitted before the game subscribed.
stream.emit(opened);
const session = createBridgeEventSource('mpgd.notifications.v2', stream);
assertEqual(stream.subscribeCalls, 0, 'the session attaches only for its first listener');
const sessionEvents: BridgeEvent[] = [];
const stopFirst = session.subscribe((event) => sessionEvents.push(event));
assertEqual(stream.subscribeCalls, 1, 'the first listener attaches the stream');
assertEqual(
  JSON.stringify(sessionEvents),
  JSON.stringify([{ protocol: 'mpgd.notifications.v2', sequence: 0, event: opened }]),
  'the buffered open reaches the first listener as sequence 0',
);
const secondListenerEvents: BridgeEvent[] = [];
const stopSecond = session.subscribe((event) => secondListenerEvents.push(event));
assertEqual(stream.subscribeCalls, 1, 'a second listener shares the attached stream');
stream.emit(received);
assertEqual(sessionEvents[1]?.sequence, 1, 'the next event is sequence 1');
assertEqual(secondListenerEvents[0]?.sequence, 1, 'every listener sees the same sequence');
for (const event of [...sessionEvents, ...secondListenerEvents]) {
  assertDoesNotThrow(() => assertBridgeEvent(event), 'a session envelope is a bridge event');
  assertDoesNotThrow(
    () => assertNotificationEventEnvelope(event),
    'a session envelope is a notifications envelope',
  );
}
stopFirst();
stopFirst();
assertEqual(stream.subscriberCount, 1, 'a remaining listener keeps the stream attached');
stopSecond();
assertEqual(stream.subscriberCount, 0, 'the last listener detaches the stream');
// The provider buffered only until its first subscriber, so an event while
// the session is detached reaches no one and takes no sequence number.
stream.emit(opened);
const afterDetach: BridgeEvent[] = [];
const stopAfterDetach = session.subscribe((event) => afterDetach.push(event));
assertEqual(stream.subscribeCalls, 2, 'a later listener attaches the stream again');
assertEqual(afterDetach.length, 0, 'an event emitted while detached is not replayed');
stream.emit(received);
assertEqual(
  JSON.stringify(afterDetach.map((event) => event.sequence)),
  JSON.stringify([2]),
  'the session keeps counting across a detach instead of starting over',
);
stopAfterDetach();

const nextSessionEvents: BridgeEvent[] = [];
const nextStream = createFakeStream<NotificationEvent>();
const nextSession = createBridgeEventSource('mpgd.notifications.v2', nextStream);
nextSession.subscribe((event) => nextSessionEvents.push(event));
nextStream.emit(received);
assertEqual(nextSessionEvents[0]?.sequence, 0, 'a new session starts at 0');

// Protocols count separately on one channel.
const commerceStream = createFakeStream<CommerceEvent>();
const commerceSession = createBridgeEventSource('mpgd.commerce.v2', commerceStream);
const commerceEnvelopes: BridgeEvent[] = [];
commerceSession.subscribe((event) => commerceEnvelopes.push(event));
commerceStream.emit({ type: 'purchaseError', error: { code: 'NETWORK', retryable: true } });
assertEqual(commerceEnvelopes[0]?.protocol, 'mpgd.commerce.v2', 'commerce envelopes name commerce');
assertEqual(commerceEnvelopes[0]?.sequence, 0, 'commerce counts its own sequence from 0');
assertDoesNotThrow(
  () => assertCommerceEventEnvelope(commerceEnvelopes[0]),
  'a commerce session envelope is a commerce envelope',
);
const presentationStream = createFakeStream<CommercePresentationEvent>();
const presentationSession = createBridgeEventSource(
  'mpgd.commerce.presentation.v1',
  presentationStream,
);
const presentationEnvelopes: BridgeEvent[] = [];
presentationSession.subscribe((event) => presentationEnvelopes.push(event));
presentationStream.emit({ idempotencyKey: 'purchase-1', sequence: 1, state: 'open' });
assertEqual(
  presentationEnvelopes[0]?.protocol,
  'mpgd.commerce.presentation.v1',
  'presentation envelopes name the presentation protocol',
);
assertEqual(presentationEnvelopes[0]?.sequence, 0, 'presentation counts its own sequence from 0');
assertDoesNotThrow(
  () => assertCommercePresentationEventEnvelope(presentationEnvelopes[0]),
  'a presentation session envelope is a presentation envelope',
);

// One failing listener does not keep the event from the others.
const isolationStream = createFakeStream<NotificationEvent>();
const isolation = createBridgeEventSource('mpgd.notifications.v2', isolationStream);
const isolated: number[] = [];
const originalWarn = console.warn;
let warnings = 0;
console.warn = () => {
  warnings += 1;
};
try {
  isolation.subscribe(() => {
    throw new Error('listener failed');
  });
  isolation.subscribe((event) => isolated.push(event.sequence));
  isolationStream.emit(received);
} finally {
  console.warn = originalWarn;
}
assertEqual(JSON.stringify(isolated), JSON.stringify([0]), 'the other listener still receives it');
assertEqual(warnings, 1, 'the failing listener is reported');

// The same listener subscribed twice is two subscriptions.
const twiceStream = createFakeStream<NotificationEvent>();
const twice = createBridgeEventSource('mpgd.notifications.v2', twiceStream);
const twiceEvents: number[] = [];
const twiceListener = (event: BridgeEvent): void => {
  twiceEvents.push(event.sequence);
};
const stopTwiceFirst = twice.subscribe(twiceListener);
const stopTwiceSecond = twice.subscribe(twiceListener);
assertEqual(twiceStream.subscribeCalls, 1, 'the stream is attached once');
twiceStream.emit(received);
assertEqual(JSON.stringify(twiceEvents), JSON.stringify([0, 0]), 'each subscription receives it');
stopTwiceFirst();
twiceStream.emit(received);
assertEqual(JSON.stringify(twiceEvents), JSON.stringify([0, 0, 1]), 'one subscription remains');
stopTwiceSecond();
assertEqual(twiceStream.subscriberCount, 0, 'the stream detaches after both leave');

// A listener that subscribes another while the stream flushes its buffer
// attaches nothing twice, and the new listener receives the later events.
const flushStream = createFakeStream<NotificationEvent>();
flushStream.emit(opened);
flushStream.emit(received);
const flushing = createBridgeEventSource('mpgd.notifications.v2', flushStream);
const lateJoiner: number[] = [];
let joined = false;
flushing.subscribe(() => {
  if (!joined) {
    joined = true;
    flushing.subscribe((event) => lateJoiner.push(event.sequence));
  }
});
assertEqual(flushStream.subscribeCalls, 1, 'a subscription during the flush does not attach again');
assertEqual(
  JSON.stringify(lateJoiner),
  JSON.stringify([1]),
  'the late listener gets the next event',
);

// A listener may leave from inside its own callback.
const selfStream = createFakeStream<NotificationEvent>();
const selfSession = createBridgeEventSource('mpgd.notifications.v2', selfStream);
let selfEvents = 0;
const stopSelf = selfSession.subscribe(() => {
  selfEvents += 1;
  stopSelf();
});
selfStream.emit(received);
selfStream.emit(received);
assertEqual(selfEvents, 1, 'a listener that left receives nothing more');
assertEqual(selfStream.subscriberCount, 0, 'the stream is detached once the listener left');

// A listener another one removes during a delivery does not receive that event.
const removalStream = createFakeStream<NotificationEvent>();
const removal = createBridgeEventSource('mpgd.notifications.v2', removalStream);
let removedEvents = 0;
removal.subscribe(() => {
  stopRemoved();
});
const stopRemoved = removal.subscribe(() => {
  removedEvents += 1;
});
removalStream.emit(received);
assertEqual(removedEvents, 0, 'the removed listener is skipped for the event being delivered');

// A stream that refuses the subscription leaves the session unattached.
let refusals = 0;
const refusing = createBridgeEventSource('mpgd.notifications.v2', {
  subscribe() {
    refusals += 1;
    throw new Error('subscribe failed');
  },
});
assertThrows(() => refusing.subscribe(() => undefined), 'a failed attach reaches the caller');
assertThrows(() => refusing.subscribe(() => undefined), 'the next listener tries to attach again');
assertEqual(refusals, 2, 'each failed attach was one attempt');

// An event the stream emits during a delivery waits for that delivery, so
// every listener sees the sequence in order.
const reentrantStream = createFakeStream<NotificationEvent>();
const reentrant = createBridgeEventSource('mpgd.notifications.v2', reentrantStream);
const firstSeen: number[] = [];
const secondSeen: number[] = [];
reentrant.subscribe((event) => {
  firstSeen.push(event.sequence);
  if (event.sequence === 0) {
    // A listener whose work makes the provider emit again.
    reentrantStream.emit(received);
  }
});
reentrant.subscribe((event) => secondSeen.push(event.sequence));
reentrantStream.emit(opened);
assertEqual(JSON.stringify(firstSeen), JSON.stringify([0, 1]), 'the first listener sees 0, then 1');
assertEqual(
  JSON.stringify(secondSeen),
  JSON.stringify([0, 1]),
  'the second listener sees 0, then 1',
);

// The last listener replacing itself during a delivery keeps the stream
// attached: a provider walking its live set would otherwise reach the second
// attachment within the same emit and deliver the event again.
const swapStream = createFakeStream<NotificationEvent>({ liveIteration: true });
const swapSession = createBridgeEventSource('mpgd.notifications.v2', swapStream);
const swapLog: string[] = [];
let stopSwapped: () => void;
const replacement = (event: BridgeEvent): void => {
  swapLog.push(`replacement ${String(event.sequence)}`);
};
stopSwapped = swapSession.subscribe((event) => {
  swapLog.push(`first ${String(event.sequence)}`);
  stopSwapped();
  stopSwapped = swapSession.subscribe(replacement);
});
swapStream.emit(opened);
assertEqual(
  JSON.stringify(swapLog),
  JSON.stringify(['first 0']),
  'a listener added during a delivery does not receive that event',
);
assertEqual(swapStream.subscribeCalls, 1, 'the stream stays attached through the swap');
assertEqual(swapStream.subscriberCount, 1, 'the session holds one stream subscription');
swapStream.emit(received);
assertEqual(
  JSON.stringify(swapLog),
  JSON.stringify(['first 0', 'replacement 1']),
  'the replacement receives the next event once',
);
stopSwapped();
assertEqual(swapStream.subscriberCount, 0, 'the last listener leaving outside a delivery detaches');

// The last listener leaving during a delivery detaches once the delivery ends.
const leavingStream = createFakeStream<NotificationEvent>();
const leaving = createBridgeEventSource('mpgd.notifications.v2', leavingStream);
let leavingEvents = 0;
let attachedWhileDelivering: number | undefined;
const stopLeaving = leaving.subscribe(() => {
  leavingEvents += 1;
  stopLeaving();
  attachedWhileDelivering = leavingStream.subscriberCount;
});
leavingStream.emit(received);
assertEqual(leavingEvents, 1, 'the leaving listener got the event');
assertEqual(attachedWhileDelivering, 1, 'the stream stays attached during the delivery');
assertEqual(leavingStream.subscriberCount, 0, 'the stream detaches after the delivery');

// A stream that fails to detach after that delivery is reported, as a
// listener's own failure is, instead of throwing into the stream's emit.
{
  let deliverToSession: ((event: NotificationEvent) => void) | undefined;
  const failingDetach = createBridgeEventSource('mpgd.notifications.v2', {
    subscribe(listener) {
      deliverToSession = listener;
      return () => {
        throw new Error('detach failed');
      };
    },
  });
  const detachWarnings: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    detachWarnings.push(args[1]);
  };
  try {
    const stop = failingDetach.subscribe(() => {
      stop();
    });
    assertDoesNotThrow(
      () => deliverToSession?.(received),
      'a failed detach does not reach the stream',
    );
  } finally {
    console.warn = warn;
  }
  assertEqual(detachWarnings.length, 1, 'the failed detach is reported once');
  assertEqual(
    (detachWarnings[0] as Error | undefined)?.message,
    'detach failed',
    'the report carries the stream error',
  );
}

// A stream that replays its buffer and then throws leaves no subscription
// behind, including one a listener made during the replay.
let replayAttempts = 0;
const replayingSubscribers = new Set<(event: NotificationEvent) => void>();
const replaying = createBridgeEventSource('mpgd.notifications.v2', {
  subscribe(listener) {
    replayAttempts += 1;
    if (replayAttempts === 1) {
      listener(opened);
      listener(received);
      throw new Error('native listener failed');
    }
    replayingSubscribers.add(listener);
    return () => {
      replayingSubscribers.delete(listener);
    };
  },
});
const replayedToFirst: number[] = [];
const replayedToNested: number[] = [];
assertThrows(
  () =>
    replaying.subscribe((event) => {
      replayedToFirst.push(event.sequence);
      if (event.sequence === 0) {
        replaying.subscribe((nested) => replayedToNested.push(nested.sequence));
      }
    }),
  'the failed attach reaches the caller',
);
assertEqual(
  JSON.stringify([replayedToFirst, replayedToNested]),
  JSON.stringify([[0, 1], [1]]),
  'the replay reached the listeners before the stream failed',
);
const afterReplayFailure: number[] = [];
replaying.subscribe((event) => afterReplayFailure.push(event.sequence));
assertEqual(replayAttempts, 2, 'the next listener attaches again');
for (const subscriber of [...replayingSubscribers]) {
  subscriber(received);
}
assertEqual(
  JSON.stringify([afterReplayFailure, replayedToNested, replayedToFirst.length]),
  JSON.stringify([[2], [1], 2]),
  'only the listener that attached the stream receives later events',
);

// A listener that returns a rejected promise is reported like one that throws.
{
  const asyncStream = createFakeStream<NotificationEvent>();
  const asyncSession = createBridgeEventSource('mpgd.notifications.v2', asyncStream);
  const asyncWarnings: unknown[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    asyncWarnings.push(args[1]);
  };
  process.on('unhandledRejection', onUnhandled);
  const asyncFailure = new Error('async listener failed');
  const afterAsync: number[] = [];
  try {
    asyncSession.subscribe(async () => {
      await Promise.resolve();
      throw asyncFailure;
    });
    asyncSession.subscribe((event) => afterAsync.push(event.sequence));
    asyncStream.emit(received);
    // Let the rejection settle and Node look for an unhandled one.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onUnhandled);
  }
  assertEqual(
    JSON.stringify(afterAsync),
    JSON.stringify([0]),
    'the next listener still receives it',
  );
  assertEqual(asyncWarnings.length, 1, 'the rejection is reported once');
  assertEqual(asyncWarnings[0], asyncFailure, 'the report carries the rejection reason');
  assertEqual(unhandled.length, 0, 'the rejection is handled');
}

// An endpoint change follows the `register` answer's time zone rule.
assertThrows(
  () => assertBridgeEvent(notificationsV2UnknownZoneEndpointChanged),
  'assertBridgeEvent rejects a registration in an unknown time zone',
);
assertThrows(
  () => assertNotificationEventEnvelope(notificationsV2UnknownZoneEndpointChanged),
  'assertNotificationEventEnvelope rejects a registration in an unknown time zone',
);
assertThrows(
  () =>
    assertBridgeNotificationsV2Result('notifications.v2.register', {
      registration: notificationsV2UnknownZoneEndpointChanged.event.registration,
    }),
  'a register answer with the same registration is rejected too',
);
const knownZoneEndpointChanged = {
  ...notificationsV2UnknownZoneEndpointChanged,
  event: {
    ...notificationsV2UnknownZoneEndpointChanged.event,
    registration: {
      ...notificationsV2UnknownZoneEndpointChanged.event.registration,
      timeZone: 'Asia/Seoul',
    },
  },
};
assertDoesNotThrow(
  () => assertBridgeEvent(knownZoneEndpointChanged),
  'assertBridgeEvent accepts a known time zone',
);
assertDoesNotThrow(
  () => assertNotificationEventEnvelope(knownZoneEndpointChanged),
  'assertNotificationEventEnvelope accepts a known time zone',
);
// The bridge keeps its own copy of the platform's time zone rule, so both
// must agree on every zone.
for (const timeZone of [
  'Asia/Seoul',
  'UTC',
  'Etc/GMT+9',
  'America/Argentina/Buenos_Aires',
  'asia/seoul',
  'Mars/Olympus_Mons',
  '+09:00',
  'GMT+9',
  ' ',
]) {
  const envelope = {
    ...knownZoneEndpointChanged,
    event: {
      ...knownZoneEndpointChanged.event,
      registration: { ...knownZoneEndpointChanged.event.registration, timeZone },
    },
  };
  const accepts = (validate: (input: unknown) => unknown): boolean => {
    try {
      validate(envelope);
      return true;
    } catch {
      return false;
    }
  };
  assertEqual(
    accepts(assertBridgeEvent),
    accepts(assertNotificationEventEnvelope),
    `the bridge and platform agree on the time zone ${JSON.stringify(timeZone)}`,
  );
}

// The overloads pair each protocol with its own events.
const commerceOnly = createFakeStream<CommerceEvent>();
// @ts-expect-error A commerce stream cannot feed the notifications protocol.
createBridgeEventSource('mpgd.notifications.v2', commerceOnly);
// @ts-expect-error A protocol that may be either one cannot pick the events.
createBridgeEventSource(eitherProtocol(), createFakeStream<NotificationEvent>());

const delivered: BridgeEvent[] = [];
const listeners = new Set<(event: BridgeEvent) => void>();
const source: BridgeEventSource = {
  subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
const [firstEvent, secondEvent] = validBridgeEvents;
const unsubscribe = source.subscribe((event) => delivered.push(event));
for (const listener of listeners) {
  listener(firstEvent);
}
unsubscribe();
for (const listener of listeners) {
  listener(secondEvent);
}
assertEqual(delivered.length, 1, 'unsubscribe should stop delivery');
assertEqual(delivered[0]?.sequence, 0, 'the subscribed listener should receive the first event');

const error = createBridgeError('request-2', 'TEMPORARY_UNAVAILABLE', 'Try again later.', true);
assertEqual(error.ok, false, 'createBridgeError should create an error response');
assertEqual(error.id, 'request-2', 'createBridgeError should preserve id');

if (!error.ok) {
  assertEqual(error.error.retryable, true, 'createBridgeError should preserve retryable flag');
}

assertEqual(
  decodeBridgeStorageLoadData({
    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
    found: false,
  }),
  null,
  'a missing storage bridge value should decode as null',
);
assertEqual(
  decodeBridgeStorageLoadData({
    __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
    found: true,
    value: null,
  })?.value,
  null,
  'a stored top-level JSON null should remain present',
);
assertEqual(
  decodeBridgeStorageLoadData(null),
  null,
  'a legacy null response should remain a missing value',
);
assertEqual(
  decodeBridgeStorageLoadData('legacy-value')?.value,
  'legacy-value',
  'a legacy raw primitive should remain a stored value',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ coins: 7 })?.value),
  JSON.stringify({ coins: 7 }),
  'a legacy raw object should remain a stored value',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ found: false, coins: 7 })?.value),
  JSON.stringify({ found: false, coins: 7 }),
  'a legacy raw object may use a false found field',
);
assertEqual(
  JSON.stringify(decodeBridgeStorageLoadData({ found: true })?.value),
  JSON.stringify({ found: true }),
  'a legacy raw object may use a true found field without a value field',
);
assertThrows(
  () =>
    decodeBridgeStorageLoadData({
      __mpgdBridgeProtocol: bridgeStorageLoadProtocol,
      found: true,
    }),
  'a present storage bridge response without a value should fail closed',
);
assertThrows(
  () => decodeBridgeStorageLoadData(undefined),
  'an absent bridge response should fail closed',
);

console.log('Bridge protocol fixture validation passed.');

function eitherProtocol(): BridgeEventProtocol {
  return 'mpgd.notifications.v2';
}

function assertDoesNotThrow(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch (error) {
    throw new Error(`${message}: ${(error as Error).message}`);
  }
}

function assertThrows(callback: () => unknown, message: string): void {
  try {
    callback();
  } catch {
    return;
  }

  throw new Error(message);
}

// The notifications backend methods: their own list, apart from the provider methods.
assertEqual(
  JSON.stringify(bridgeNotificationsBackendMethods),
  JSON.stringify(notificationBackendBridgeMethods),
  'bridge notifications backend methods should equal @mpgd/platform/notifications notificationBackendBridgeMethods',
);
for (const method of bridgeNotificationsBackendMethods) {
  assertEqual(
    isBridgeNotificationsBackendMethod(method),
    true,
    `${method} should be a backend method`,
  );
  assertEqual(isBridgeNotificationsV2Method(method), false, `${method} is not a provider method`);
  assertDoesNotThrow(
    () => assertBridgeRequest({ ...validBridgeRequest, method }),
    `${method} should be a bridge method`,
  );
  const answer = createNotificationsBackendUnavailableBridgeError(
    { id: `backend-${method}`, method },
    'Test transport',
  );
  assertDoesNotThrow(
    () => assertBridgeResponse(answer),
    `${method} unavailable response should pass`,
  );
  if (answer.ok) {
    throw new Error(`${method} without a backend should fail.`);
  }
  assertEqual(
    answer.error.code,
    'NOTIFICATIONS_CONFIGURATION_REQUIRED',
    `${method} without a backend`,
  );
  assertEqual(answer.error.retryable, false, `${method} without a backend is not retryable`);
}
for (const method of bridgeNotificationsV2Methods) {
  assertEqual(
    isBridgeNotificationsBackendMethod(method),
    false,
    `${method} is not a backend method`,
  );
}
assertThrows(
  () =>
    assertBridgeNotificationsBackendPayload(
      'notifications.v2.getPermission' as 'notifications.backend.getSession',
      {},
    ),
  'a provider method should not reach a backend payload validator',
);
assertThrows(
  () => assertBridgeNotificationsBackendPayload('notifications.backend.listConsent', {}),
  'a backend call names the player it began for',
);
assertDoesNotThrow(
  () =>
    assertBridgeNotificationsBackendResult('notifications.backend.getSession', { session: null }),
  'a signed-out session read passes',
);

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
