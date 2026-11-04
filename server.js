'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.html');
const MAX_BODY = 8192;
const MAX_RESPONSE = 3 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const rate = new Map();

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIPv6(ip) {
  const x = ip.toLowerCase().split('%')[0];
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') ||
    /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('::ffff:');
}

async function assertPublicHost(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed.');
  if (url.username || url.password) throw new Error('URLs containing credentials are not allowed.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Blocked host: destination must be a public internet host.');
  }
  const kind = net.isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) throw new Error('Blocked private or reserved IP address.');
  if (kind === 6 && isPrivateIPv6(host)) throw new Error('Blocked private or reserved IPv6 address.');
  if (!kind) {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(r => r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address))) {
      throw new Error('Blocked host: DNS resolved to a private or reserved address.');
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function rateLimited(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rate.get(ip) || { start: now, count: 0 };
  if (now - entry.start >= 60000) { entry.start = now; entry.count = 0; }
  entry.count++;
  rate.set(ip, entry);
  if (entry.count > 30) {
    sendJson(res, 429, { error: 'Too many requests. Wait one minute and retry.' });
    return true;
  }
  return false;
}

async function fetchPublicResource(rawUrl) {
  let current = new URL(rawUrl);
  for (let hop = 0; hop <= 4; hop++) {
    await assertPublicHost(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'PURE-DUMPER-V24 public-resource-inspector',
          'Accept': 'text/html,application/javascript,text/css,application/json,*/*;q=0.8'
        }
      });
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 4) throw new Error('Too many redirects (maximum 4).');
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect response has no Location header.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      const error = new Error(`Remote server returned HTTP ${response.status}.`);
      error.status = 502;
      throw error;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE) throw new Error('Remote response exceeds the 3 MB limit.');
    if (!response.body) throw new Error('Remote server returned an empty response.');

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) {
        await reader.cancel();
        throw new Error('Remote response exceeds the 3 MB limit.');
      }
      chunks.push(Buffer.from(value));
    }
    return {
      text: Buffer.concat(chunks).toString('utf8'),
      status: response.status,
      finalUrl: current.href,
      contentType: response.headers.get('content-type') || ''
    };
  }
  throw new Error('Unable to complete redirect chain.');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function serveIndex(res) {
  fs.readFile(INDEX, (error, data) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html is missing. Put index.html beside server.js.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'PURE DUMPER HTML V24', node: process.version });
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveIndex(res);
  }

  if (req.method === 'POST' && pathname === '/api/fetch') {
    if (rateLimited(req, res)) return;
    try {
      const rawBody = await readRequestBody(req);
      const parsed = JSON.parse(rawBody || '{}');
      if (typeof parsed.url !== 'string' || parsed.url.length > 2048) {
        return sendJson(res, 400, { error: 'Provide a valid URL (maximum 2048 characters).' });
      }
      let target;
      try { target = new URL(parsed.url); }
      catch { return sendJson(res, 400, { error: 'Invalid URL.' }); }
      const result = await fetchPublicResource(target.href);
      return sendJson(res, 200, result);
    } catch (error) {
      const status = error.status || (/Only HTTP|credentials|Blocked|private|reserved|Invalid URL/i.test(error.message) ? 400 : 502);
      return sendJson(res, status, {
        error: error.name === 'AbortError' ? 'Remote request timed out.' : error.message
      });
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD, POST' });
    return res.end('Method not allowed');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PURE DUMPER V24 listening on port ${PORT}`);
});
