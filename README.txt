PURE DUMPER HTML V23 — SETUP
============================

This release includes the requested fetch-status and diagnostics features AND the small Node.js backend needed to retrieve public pages without browser CORS blocking.

FILES
- index.html  : single-page English interface (one URL field)
- server.js   : same-origin backend fetch service
- package.json: Node.js start configuration

DEPLOY
1. Create a new Node.js web service on your hosting provider (for example Render).
2. Upload/extract this entire project folder or connect its Git repository.
3. Runtime: Node.js 20 or newer.
4. Build command: leave empty (no dependencies).
5. Start command: npm start
6. Open the service's HTTPS URL. Do not open index.html as a local file; the backend API must be running on the same origin.

FEATURES
- Auto Fetch Status
- CORS diagnosis (backend fetch avoids browser cross-origin restrictions)
- Three attempts for transient network errors
- Error diagnosis for DNS, TLS, timeout, HTTP denial, rate limit, server errors and response-size limits
- Automatic HTML/JS/CSS detection after content is received
- Deobfuscation only starts after source text has actually been retrieved
- Complete extracted-code box and copy/download controls from the previous UI

SAFETY / LIMITS
- Fetches public HTTP/HTTPS resources only.
- Rejects localhost, private/reserved IPs and DNS names resolving to private addresses.
- Does not bypass login, paywalls, bot challenges, access controls or retrieve private backend source.
- Does not execute downloaded scripts.
- Maximum 3 MB per fetched resource; up to 4 redirects.
- Public pages may still deny server-side requests or require browser interaction.
