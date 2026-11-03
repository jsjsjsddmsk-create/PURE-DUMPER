# PURE DUMPER HTML V24

## Render deployment
- Runtime: Node.js 20+
- Build command: `npm install`
- Start command: `npm start`
- Root directory: leave blank

## Files
- `index.html` — web interface
- `server.js` — safe public-resource fetch backend
- `package.json` — start script and runtime

## Scope and limitations
Inspects publicly delivered HTML, JavaScript, CSS, and linked assets. It cannot retrieve private server-side source code (including the backend of a Render app), bypass authentication, paywalls, bot challenges, or access controls. It does not execute downloaded code. Some sites block automated requests, require browser interaction, or render content dynamically; in those cases results can be partial. Obfuscator detection and static decoding are heuristic and cannot guarantee recovery of original source.
