import { Readable } from 'node:stream';
import { handleHttpRequest } from '../../src/server.js';

class BufferedResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.headersSent = false;
    this.ended = false;
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), [name, value]); }
  hasHeader(name) { return this.headers.has(name.toLowerCase()); }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }
  end(chunk = '') {
    if (chunk !== undefined && chunk !== null && chunk !== '') this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    this.ended = true;
    return this;
  }
}

export default async function api(request, context) {
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const nodeRequest = Readable.from(body.length ? [body] : []);
  nodeRequest.method = request.method;
  nodeRequest.url = `${url.pathname}${url.search}`;
  nodeRequest.headers = Object.fromEntries(request.headers.entries());
  nodeRequest.headers.host ||= url.host;
  nodeRequest.socket = { remoteAddress: context.ip || '127.0.0.1' };

  const response = new BufferedResponse();
  await handleHttpRequest(nodeRequest, response);
  const headers = Object.fromEntries([...response.headers.values()]);
  const responseBody = Buffer.concat(response.chunks);
  return new Response(responseBody.length ? responseBody : null, {
    status: response.statusCode,
    headers
  });
}

export const config = { path: '/api/v1/*' };
