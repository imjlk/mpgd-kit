import { createServer } from 'node:http';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Loopback-only test origin. Fault controls stay in-process, never in HTTP routes. */
export async function staticServer(directory, { cors = false, port = 0 } = {}) {
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const requests = [];
  const faults = new Map();
  const delays = new Map();
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer(async (request, response) => {
    if (cors) response.setHeader('Access-Control-Allow-Origin', '*');
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      requests.push(path);
      if (delays.has(path)) await delay(delays.get(path));
      if (response.destroyed) return;
      const fault = faults.get(path);
      if (fault?.kind === 'status' && fault.remaining !== 0) {
        if (Number.isFinite(fault.remaining)) fault.remaining--;
        response.writeHead(fault.status).end('Injected test failure');
        return;
      }
      const file = await realpath(resolve(root, `.${path === '/' ? '/index.html' : path}`));
      if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      let bytes = await readFile(file);
      if (fault?.kind === 'corrupt') { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
      if (fault?.kind === 'oversize') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', bytes.length);
      response.setHeader('Cache-Control', path.startsWith('/packs/') ? 'public, max-age=31536000, immutable' : 'no-store');
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      if (!response.destroyed) response.writeHead(404).end('Not found');
    }
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`, requests, faults, delays,
    async close() { server.closeAllConnections(); await new Promise((yes, no) => server.close((error) => error ? no(error) : yes())); },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await staticServer(resolve(process.argv[2] ?? 'artifacts/origin'), { cors: true, port: Number(process.argv[3] ?? 5196) });
  console.info(`Static asset origin: ${server.url}`);
  process.once('SIGINT', () => { void server.close(); });
  process.once('SIGTERM', () => { void server.close(); });
}
