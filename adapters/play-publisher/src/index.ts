import { createReadStream } from 'node:fs';

import { androidpublisher, auth, type androidpublisher_v3 } from '@googleapis/androidpublisher';

import type { PlayPublisher } from '../../../packages/cli/src/play-publisher-port.js';

const scope = 'https://www.googleapis.com/auth/androidpublisher';

/** Production Google Play adapter, bundled into the CLI tarball at package build time. */
export function createServiceAccountPublisher(serviceAccountFile: string): PlayPublisher {
  const googleAuth = new auth.GoogleAuth({ keyFile: serviceAccountFile, scopes: [scope] });
  return wrapPublisher(androidpublisher({ version: 'v3', auth: googleAuth }));
}

/** Test-only path for a mock HTTP server with a fixture OAuth token. */
export function createMockPublisher(accessToken: string, rootUrl: string): PlayPublisher {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return wrapPublisher(androidpublisher({ version: 'v3', auth: oauth, rootUrl }));
}

function wrapPublisher(publisher: ReturnType<typeof androidpublisher>): PlayPublisher {
  return {
    async insertEdit(packageName) {
      const response = await publisher.edits.insert({ packageName }, { retry: false });
      if (typeof response.data.id !== 'string' || response.data.id.trim() === '') {
        throw new Error('Google Play did not return an edit ID.');
      }
      return response.data.id;
    },
    async listBundles(packageName, editId) {
      return (await publisher.edits.bundles.list({ packageName, editId })).data.bundles ?? [];
    },
    async uploadBundle(input) {
      const response = await publisher.edits.bundles.upload({
        packageName: input.packageName,
        editId: input.editId,
        media: { mimeType: 'application/octet-stream', body: createReadStream(input.aabFile) },
      }, {
        timeout: input.timeoutMs,
        retry: false,
        // The generated SDK's media endpoint ignores the client's rootUrl.
        ...(input.requestRootUrl === undefined ? {} : { rootUrl: input.requestRootUrl }),
      });
      return response.data;
    },
    async getTrack(packageName, editId) {
      return (await publisher.edits.tracks.get({ packageName, editId, track: 'internal' })).data;
    },
    async updateTrack(packageName, editId, track) {
      await publisher.edits.tracks.update({
        packageName, editId, track: 'internal',
        requestBody: track as androidpublisher_v3.Schema$Track,
      }, { retry: false });
    },
    async validateEdit(packageName, editId) {
      await publisher.edits.validate({ packageName, editId }, { retry: false });
    },
    async commitEdit(packageName, editId) {
      await publisher.edits.commit({
        packageName, editId, changesInReviewBehavior: 'ERROR_IF_IN_REVIEW',
      }, { retry: false });
    },
  };
}
