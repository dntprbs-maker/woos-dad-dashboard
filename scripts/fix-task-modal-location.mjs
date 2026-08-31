import fs from 'node:fs';

const path = 'index.html';
let s = fs.readFileSync(path, 'utf8');

const modalStart = s.indexOf('<div class="modal-wrap" id="modalWrap"');
if (modalStart < 0) throw new Error('modalWrap not found');

const scriptStart = s.indexOf('\n<script>', modalStart);
if (scriptStart < 0) throw new Error('script marker after modalWrap not found');

const modalBlock = s.slice(modalStart, scriptStart).trimEnd();
const detailStart = s.indexOf('  <div class="detail-page" id="detailPage">');
if (detailStart < 0) throw new Error('detailPage marker not found');

// 이미 detailPage 밖에 있으면 종료
if (modalStart < detailStart) {
  console.log('modalWrap already outside detailPage');
  process.exit(0);
}

// 기존 위치에서 제거
s = s.slice(0, modalStart) + s.slice(scriptStart);

// 홈 화면 종료와 detailPage 시작 사이에 공용 상세 팝업을 배치한다.
const newDetailStart = s.indexOf('  <div class="detail-page" id="detailPage">');
s = s.slice(0, newDetailStart) + modalBlock + '\n\n' + s.slice(newDetailStart);

fs.writeFileSync(path, s);
console.log('moved modalWrap outside detailPage');
