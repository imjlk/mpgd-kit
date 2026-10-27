import { createReadStream } from 'node:fs';

import { androidpublisher, auth, type androidpublisher_v3 } from '@googleapis/androidpublisher';

import type {
  PlayOneTimeProduct,
  PlayProductCatalogPort,
} from '../../../packages/cli/src/play-product-port.js';
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
    async insertEdit(packageName, signal) {
      const response = await publisher.edits.insert(
        { packageName }, { retry: false, signal: signal as never },
      );
      if (typeof response.data.id !== 'string' || response.data.id.trim() === '') {
        throw new Error('Google Play did not return an edit ID.');
      }
      return response.data.id;
    },
    async listBundles(packageName, editId, signal) {
      return (await publisher.edits.bundles.list(
        { packageName, editId }, { signal: signal as never },
      )).data.bundles ?? [];
    },
    async uploadBundle(input) {
      const response = await publisher.edits.bundles.upload({
        packageName: input.packageName,
        editId: input.editId,
        media: { mimeType: 'application/octet-stream', body: createReadStream(input.aabFile) },
      }, {
        timeout: input.timeoutMs,
        retry: false,
        signal: input.signal as never,
        // The generated SDK's media endpoint ignores the client's rootUrl.
        ...(input.requestRootUrl === undefined ? {} : { rootUrl: input.requestRootUrl }),
      });
      return response.data;
    },
    async uploadDeobfuscationFile(input) {
      await publisher.edits.deobfuscationfiles.upload({
        packageName: input.packageName,
        editId: input.editId,
        apkVersionCode: input.versionCode,
        deobfuscationFileType: 'proguard',
        media: { mimeType: 'application/octet-stream', body: createReadStream(input.mappingFile) },
      }, {
        timeout: input.timeoutMs,
        retry: false,
        signal: input.signal as never,
        ...(input.requestRootUrl === undefined ? {} : { rootUrl: input.requestRootUrl }),
      });
    },
    async getTrack(packageName, editId, track, signal) {
      return (await publisher.edits.tracks.get(
        { packageName, editId, track }, { signal: signal as never },
      )).data;
    },
    async updateTrack(packageName, editId, track, signal) {
      if (typeof track.track !== 'string' || track.track === '') {
        throw new Error('Google Play track update needs a track name.');
      }
      await publisher.edits.tracks.update({
        packageName, editId, track: track.track,
        requestBody: track as androidpublisher_v3.Schema$Track,
      }, { retry: false, signal: signal as never });
    },
    async validateEdit(packageName, editId, signal) {
      await publisher.edits.validate(
        { packageName, editId }, { retry: false, signal: signal as never },
      );
    },
    async commitEdit(packageName, editId, signal) {
      await publisher.edits.commit({
        packageName, editId, changesInReviewBehavior: 'ERROR_IF_IN_REVIEW',
      }, { retry: false, signal: signal as never });
    },
    async deleteEdit(packageName, editId, signal) {
      await publisher.edits.delete(
        { packageName, editId }, { retry: false, signal: signal as never },
      );
    },
  };
}

/** Production one-time product catalog port (`monetization.onetimeproducts`). */
export function createServiceAccountProductCatalog(serviceAccountFile: string): PlayProductCatalogPort {
  const googleAuth = new auth.GoogleAuth({ keyFile: serviceAccountFile, scopes: [scope] });
  return wrapProductCatalog(androidpublisher({ version: 'v3', auth: googleAuth }));
}

/** Test-only product catalog port for a mock HTTP server with a fixture OAuth token. */
export function createMockProductCatalog(accessToken: string, rootUrl: string): PlayProductCatalogPort {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  return wrapProductCatalog(androidpublisher({ version: 'v3', auth: oauth, rootUrl }));
}

function wrapProductCatalog(publisher: ReturnType<typeof androidpublisher>): PlayProductCatalogPort {
  const products = publisher.monetization.onetimeproducts;
  return {
    async listOneTimeProducts(packageName, signal) {
      const all: PlayOneTimeProduct[] = [];
      let pageToken: string | undefined;
      do {
        const response = await products.list({
          packageName,
          pageSize: 1000,
          ...(pageToken === undefined ? {} : { pageToken }),
        }, { signal: signal as never });
        all.push(...(response.data.oneTimeProducts ?? []) as unknown as PlayOneTimeProduct[]);
        const next = response.data.nextPageToken;
        pageToken = typeof next === 'string' && next !== '' ? next : undefined;
      } while (pageToken !== undefined);
      return all;
    },
    async convertRegionPrices(input) {
      const response = await publisher.monetization.convertRegionPrices({
        packageName: input.packageName,
        requestBody: {
          price: input.price as androidpublisher_v3.Schema$Money,
          ...(input.productTaxCategoryCode === undefined
            ? {}
            : { productTaxCategoryCode: input.productTaxCategoryCode }),
        },
      }, { signal: input.signal as never });
      return response.data;
    },
    async patchOneTimeProduct(input) {
      const response = await products.patch({
        packageName: input.packageName,
        productId: input.productId,
        allowMissing: input.allowMissing,
        updateMask: input.updateMask,
        'regionsVersion.version': input.regionsVersion,
        requestBody: input.product as unknown as androidpublisher_v3.Schema$OneTimeProduct,
      }, { retry: false, signal: input.signal as never });
      return response.data as unknown as PlayOneTimeProduct;
    },
    async activatePurchaseOption(input) {
      await products.purchaseOptions.batchUpdateStates({
        packageName: input.packageName,
        productId: input.productId,
        requestBody: {
          requests: [{
            activatePurchaseOptionRequest: {
              packageName: input.packageName,
              productId: input.productId,
              purchaseOptionId: input.purchaseOptionId,
            },
          }],
        },
      }, { retry: false, signal: input.signal as never });
    },
  };
}
