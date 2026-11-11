import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 8080);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm']
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const safePath = normalize(pathname).replace(/^([/\\])+/, '');
    let filePath = resolve(join(root, safePath || 'index.html'));

    if (filePath !== root && !filePath.startsWith(root + sep)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }

    if (filePath.endsWith('/')) filePath = join(filePath, 'index.html');

    const data = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(extname(filePath)) || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch (error) {
    response.writeHead(error && error.code === 'ENOENT' ? 404 : 500);
    response.end(error && error.code === 'ENOENT' ? 'Not found' : 'Server error');
  }
}).listen(port, () => {
  console.log(`City crowd demo: http://localhost:${port}`);
});
