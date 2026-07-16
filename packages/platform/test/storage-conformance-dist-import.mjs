import {
  runStorageAdapterConformance,
  storageAdapterConformanceScenarios,
} from '@mpgd/platform/storage-conformance';

if (typeof runStorageAdapterConformance !== 'function') {
  throw new Error('Missing runStorageAdapterConformance export.');
}

if (storageAdapterConformanceScenarios.length !== 7) {
  throw new Error('Unexpected storage adapter conformance scenario count.');
}
