import fs from 'node:fs';

const file = 'index.html';
let s = fs.readFileSync(file, 'utf8');

s = s.replace('<div class="k">담당</div><div class="v" id="mWorker"></div>', '<div class="k">작업자</div><div class="v" id="mWorker"></div>');
s = s.replaceAll('담당자 이름', '작업자 이름');
s = s.replaceAll('작성자·의뢰자·수행자·상태·작업유형', '작성자·의뢰자·작업자·상태·작업유형');
s = s.replaceAll('수행자', '작업자');

fs.writeFileSync(file, s);
console.log('standardized terminology to 작업자');
