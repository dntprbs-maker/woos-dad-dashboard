import fs from 'node:fs';

const path = 'index.html';
let s = fs.readFileSync(path, 'utf8');

const startMarker = 'function renderNeedsCheck(grouped)';
const endMarker = '\nasync function loadLiveNotionData(){';
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  throw new Error('needs-check runtime block not found');
}

const before = s.slice(0, start);
let block = s.slice(start, end);
const after = s.slice(end);

block = block.replace(/\\`/g, '`').replace(/\\\$\{/g, '${');

s = before + block + after;
fs.writeFileSync(path, s);
console.log('needs-check runtime template literals normalized');
