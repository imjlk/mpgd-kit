import assert from 'node:assert/strict';

import {
  createUnsupportedPlatformAnalyticsSink,
  platformAnalyticsLogTypes,
  readPlatformAnalyticsLog,
  readPlatformAnalyticsStatus,
} from '@mpgd/platform/analytics';

assert.deepEqual(platformAnalyticsLogTypes, ['screen', 'event', 'click', 'impression']);
assert.deepEqual(readPlatformAnalyticsLog({ logName: 'play_start', logType: 'event' }), {
  logName: 'play_start',
  logType: 'event',
  params: {},
});
assert.equal(readPlatformAnalyticsLog({ logName: 'play_start', logType: 'event', params: { user_id: 'a' } }), undefined);
assert.equal(readPlatformAnalyticsStatus({ provider: 'none', state: 'unsupported', logTypes: ['event'] }).logTypes.length, 0);
const sink = createUnsupportedPlatformAnalyticsSink();
assert.deepEqual(await sink.getStatus(), { provider: 'none', state: 'unsupported', logTypes: [] });
assert.equal(await sink.log({ logName: 'play_start', logType: 'event' }), false);
