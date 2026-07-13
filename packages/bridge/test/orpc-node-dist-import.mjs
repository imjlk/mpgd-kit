import { createBridgeRpcNodeHandler } from '../dist/orpc-node.js';

if (typeof createBridgeRpcNodeHandler !== 'function') {
  throw new Error('@mpgd/bridge/orpc/node did not expose createBridgeRpcNodeHandler.');
}

console.log('@mpgd/bridge/orpc/node Node ESM import passed.');
