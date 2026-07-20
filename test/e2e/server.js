'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '../..');
const fixture = path.join(__dirname, 'fixture.html');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file;
  if (pathname.startsWith('/maps/')) file = fixture;
  else file = path.resolve(repo, '.' + pathname);
  if (file !== fixture && !file.startsWith(repo + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
}).listen(41739, '127.0.0.1');
