'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');

const PORT = Number(process.env.PORT || 3000);
const INDEX = path.join(__dirname, 'index.html');
const MAX_BODY = 10 * 1024;
const MAX_RESPONSE = 3 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const rate = new Map();

function privateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a,b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
function privateIPv6(ip) {
  const x = ip.toLowerCase().split('%')[0];
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') ||
    /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('::ffff:');
}
async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS are supported.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private/local destinations are blocked.');
  const kind = net.isIP(host);
  if (kind === 4 && privateIPv4(host)) throw new Error('Private or reserved IP addresses are blocked.');
  if (kind === 6 && privateIPv6(host)) throw new Error('Private or reserved IPv6 addresses are blocked.');
  if (!kind) {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(r => r.family === 4 ? privateIPv4(r.address) : privateIPv6(r.address))) {
      throw new Error('This hostname resolves to a private or reserved address.');
    }
  }
}
function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
function limited(req, res) {
  const ip = req.socket.remoteAddress || 'unknown', now = Date.now();
  let item = rate.get(ip) || {start:now,count:0};
  if (now - item.start > 60000) item = {start:now,count:0};
  item.count++; rate.set(ip,item);
  if (item.count > 20) { json(res,429,{error:'Request limit reached. Try again in one minute.'}); return true; }
  return false;
}
async function fetchPublic(raw) {
  let url = new URL(raw);
  for (let hop=0; hop<=4; hop++) {
    await assertPublic(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {redirect:'manual',signal:controller.signal,headers:{
        'User-Agent':'PURE-DUMPER-PRO/25.0 public-resource-inspector',
        'Accept':'text/html,application/xhtml+xml,application/javascript,text/css,application/json;q=0.9,*/*;q=0.5'
      }});
    } finally { clearTimeout(timer); }
    if ([301,302,303,307,308].includes(response.status)) {
      if (hop===4) throw new Error('Redirect limit reached.');
      const loc=response.headers.get('location');
      if (!loc) throw new Error('Redirect did not include a destination.');
      url=new URL(loc,url); continue;
    }
    if (!response.ok) throw new Error(`Remote website returned HTTP ${response.status}.`);
    const type=response.headers.get('content-type') || '';
    if (!/(text\/|javascript|json|xml|svg)/i.test(type)) throw new Error(`Unsupported content type: ${type || 'unknown'}.`);
    const declared=Number(response.headers.get('content-length') || 0);
    if (declared>MAX_RESPONSE) throw new Error('Response is larger than 3 MB.');
    if (!response.body) throw new Error('The website returned an empty response.');
    const reader=response.body.getReader(), chunks=[]; let total=0;
    while (true) {
      const {done,value}=await reader.read(); if(done) break;
      total+=value.byteLength;
      if(total>MAX_RESPONSE){await reader.cancel();throw new Error('Response is larger than 3 MB.');}
      chunks.push(Buffer.from(value));
    }
    return {text:Buffer.concat(chunks).toString('utf8'),status:response.status,finalUrl:url.href,contentType:type};
  }
  throw new Error('Could not finish redirect chain.');
}
function body(req) {
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data',c=>{data+=c.toString('utf8');if(Buffer.byteLength(data)>MAX_BODY){reject(new Error('Request too large.'));req.destroy();}});
    req.on('end',()=>resolve(data)); req.on('error',reject);
  });
}
const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET' && pathname==='/api/health') return json(res,200,{ok:true,service:'PURE DUMPER HTML V24',node:process.version});
  if(req.method==='GET' && (pathname==='/' || pathname==='/index.html')) {
    return fs.readFile(INDEX,(e,b)=>{if(e){res.writeHead(500);return res.end('index.html is missing.');}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});res.end(b);});
  }
  if(req.method==='POST' && pathname==='/api/fetch') {
    if(limited(req,res)) return;
    try {
      const parsed=JSON.parse(await body(req) || '{}');
      if(typeof parsed.url!=='string' || parsed.url.length>2048) return json(res,400,{error:'Enter a valid public website URL.'});
      let target; try{target=new URL(parsed.url);}catch{return json(res,400,{error:'URL format is invalid.'});}
      const result=await fetchPublic(target.href); return json(res,200,result);
    } catch(e) {
      const status=/private|blocked|credentials|Only HTTP|reserved|invalid/i.test(e.message)?400:(e.name==='AbortError'?504:502);
      return json(res,status,{error:e.name==='AbortError'?'The website took too long to respond.':e.message});
    }
  }
  if(req.method!=='GET' && req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD, POST'});return res.end('Method not allowed');}
  res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not Found');
});
server.listen(PORT,'0.0.0.0',()=>console.log(`PURE DUMPER HTML V24 listening on ${PORT}`));
