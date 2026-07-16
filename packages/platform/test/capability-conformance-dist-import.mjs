import {
  platformCapabilityKeys,
  runPlatformGatewayCapabilityConformance,
} from '@mpgd/platform/capability-conformance';

if (typeof runPlatformGatewayCapabilityConformance !== 'function') {
  throw new Error('Expected the platform capability conformance runner export.');
}

if (platformCapabilityKeys.length !== 10 || !Object.isFrozen(platformCapabilityKeys)) {
  throw new Error('Expected the complete frozen platform capability key export.');
}

console.log('@mpgd/platform/capability-conformance Node ESM import passed.');
