// Tiny static server for the test pages, so they can be opened over http
// instead of file:// (module imports and content scripts both need that).
//
//   node tools/serve.js            -> http://localhost:8123
//   node tools/serve.js 9000       -> http://localhost:9000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
};

http
  .createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.join(ROOT, requested === '/' ? '/tests/test.html' : requested);

    // Never serve anything outside the project directory.
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + requested);
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES[path.extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Serving ${ROOT}`);
    console.log(`  tests:    http://localhost:${PORT}/tests/test.html`);
    console.log(`  fixtures: http://localhost:${PORT}/tests/forms.html`);
  });
