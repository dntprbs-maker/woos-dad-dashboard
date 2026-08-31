import fs from 'node:fs';
const path='index.html';
let s=fs.readFileSync(path,'utf8');
const old='      const item = {\n        title: t.title || "(제목 없음)",';
const next='      const item = {\n        id: t.id || "",\n        title: t.title || "(제목 없음)",';
if(s.includes(old)){
  s=s.replace(old,next);
  fs.writeFileSync(path,s);
  console.log('Notion task id preserved');
}else if(!s.includes('        id: t.id || "",')){
  throw new Error('task item anchor not found');
}
