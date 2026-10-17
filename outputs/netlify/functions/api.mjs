import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { handleRequest, initializeSupabaseOnce } = require('../../server.js');
const functionPrefix = '/.netlify/functions/api';

export default async function handler(request, context) {
  await initializeSupabaseOnce();

  const url = new URL(request.url);
  const requestPath = url.pathname.startsWith(functionPrefix)
    ? url.pathname.slice(functionPrefix.length) || '/'
    : url.pathname;
  const requestStream = Readable.from([Buffer.from(await request.arrayBuffer())]);
  const headers = Object.fromEntries(request.headers.entries());
  requestStream.method = request.method;
  requestStream.url = requestPath + url.search;
  requestStream.headers = headers;
  requestStream.socket = {
    remoteAddress: headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || context.ip || 'unknown',
    encrypted: true
  };

  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const responseHeaders = {};
    const chunks = [];
    let ended = false;
    const response = {
      writeHead(status, headersToAdd = {}) {
        statusCode = status;
        Object.assign(responseHeaders, headersToAdd);
        return response;
      },
      end(body = '') {
        if (ended) return;
        ended = true;
        if (body !== undefined && body !== null && body !== '') {
          chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
        }
        resolve(new Response(Buffer.concat(chunks), { status: statusCode, headers: responseHeaders }));
      }
    };
    Promise.resolve(handleRequest(requestStream, response)).catch(reject);
  });
}
