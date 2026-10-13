import {
  platformCapabilityKeys,
  runPlatformGatewayCapabilityConformance,
} from '@mpgd/platform/capability-conformance';

if (typeof runPlatformGatewayCapabilityConformance !== 'function') {
  throw new Error('Expected the platform capability conformance runner export.');
}

// C4 removed the boolean `nativeIap` flag: the required `commerce` block is the
// commerce source and is validated by the runner itself, not listed here.
if (
  platformCapabilityKeys.length !== 10
  || !Object.isFrozen(platformCapabilityKeys)
  || platformCapabilityKeys.includes('nativeIap')
) {
  throw new Error('Expected the complete frozen platform capability key export.');
}

console.log('@mpgd/platform/capability-conformance Node ESM import passed.');
