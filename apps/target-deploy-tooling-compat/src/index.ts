import { androidpublisher, auth } from '@googleapis/androidpublisher';
import { buildsGetCollection, createClient } from 'appstore-connect-sdk';

const FIXTURE_TOKEN = 'compatibility-fixture-token';

/** A credential-free probe of the exact clients the deployment CLI may consume. */
export async function probeGooglePublisher(baseUrl: string): Promise<string> {
  const oauth = new auth.OAuth2();
  oauth.setCredentials({ access_token: FIXTURE_TOKEN });
  const publisher = androidpublisher({ version: 'v3', auth: oauth, rootUrl: baseUrl });
  const result = await publisher.edits.insert({ packageName: 'dev.mpgd.compat' });
  if (typeof result.data.id !== 'string') {
    throw new Error('Google edit ID missing');
  }
  return result.data.id;
}

/** The SDK candidate is probed separately; its build-upload API is not an IPA transfer. */
export async function probeAppleSdk(baseUrl: string): Promise<string> {
  const client = createClient({
    bearerToken: FIXTURE_TOKEN,
    baseUrl,
  });
  const result = await buildsGetCollection({ client });
  const build = result.data?.data?.[0];
  if (typeof build?.id !== 'string') {
    throw new Error('Apple build ID missing');
  }
  return build.id;
}
