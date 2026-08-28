import fs from 'node:fs';

const path = 'index.html';
let s = fs.readFileSync(path, 'utf8');

const compactCss = `
  /* 확인필요: 첫 화면 한 줄 + 팝업 목록 */
  .needs-check-panel{
    background:transparent!important;border:0!important;border-radius:0!important;
    padding:0!important;margin:0 0 16px!important;box-shadow:none!important;
  }
  .needs-check-summary{
    width:100%;border:1px solid #fde3a7;background:#fff8e8;border-radius:16px;
    min-height:58px;padding:0 15px;display:flex;align-items:center;gap:10px;
    color:var(--text);text-align:left;box-shadow:var(--shadow);cursor:pointer;
  }
  .needs-check-summary .summary-label{font-size:15px;font-weight:800;flex:1}
  .needs-check-summary .needs-check-count{display:grid;place-items:center;min-width:28px;height:28px;padding:0 8px;background:#f59e0b;color:#fff;border-radius:999px;font-size:12px;font-weight:800}
  .needs-check-summary .summary-arrow{font-size:22px;color:#9a6a00;line-height:1}
  .needs-check-modal-wrap{position:fixed;inset:0;background:rgba(15,23,42,.38);display:none;align-items:flex-end;justify-content:center;z-index:120;padding-top:36px}
  .needs-check-modal-wrap.show{display:flex}
  .needs-check-modal{width:100%;max-width:480px;max-height:88vh;overflow:hidden;background:#fff;border-radius:24px 24px 0 0;box-shadow:0 -16px 44px rgba(15,23,42,.2);display:flex;flex-direction:column}
  .needs-check-modal-head{display:flex;align-items:center;gap:9px;padding:17px 16px 13px;border-bottom:1px solid var(--line)}
  .needs-check-modal-head strong{font-size:18px;flex:1}.needs-check-modal-close{width:36px;height:36px;border:0;border-radius:11px;background:#f3f5f8;color:#64748b;font-size:22px}
  .needs-check-modal-list{overflow:auto;padding:12px 14px calc(22px + env(safe-area-inset-bottom))}
  .needs-check-modal-list .needs-check-item{margin:0 0 9px;background:#fffdf7}
  .modal-wrap.needs-check-detail{z-index:140!important}
`;
if(!s.includes('/* 확인필요: 첫 화면 한 줄 + 팝업 목록 */')){
  s = s.replace('\n</style>', compactCss + '\n</style>');
}else if(!s.includes('.modal-wrap.needs-check-detail')){
  s = s.replace('\n</style>', '\n  .modal-wrap.needs-check-detail{z-index:140!important}\n</style>');
}

const compactPanel = `    <section class="needs-check-panel hidden" id="needsCheckPanel" aria-live="polite">
      <button class="needs-check-summary" type="button" onclick="openNeedsCheckModal()" aria-label="확인필요 작업 열기">
        <span aria-hidden="true">🔔</span>
        <span class="summary-label">확인필요</span>
        <span class="needs-check-count" id="needsCheckCount">0</span>
        <span class="summary-arrow" aria-hidden="true">›</span>
      </button>
    </section>`;

const panelRe = /    <section class="needs-check-panel hidden" id="needsCheckPanel" aria-live="polite">[\s\S]*?    <\/section>/;
if(!panelRe.test(s)) throw new Error('needs-check panel not found');
s = s.replace(panelRe, compactPanel);

if(!s.includes('id="needsCheckModalWrap"')){
  const modal = `

    <div class="needs-check-modal-wrap" id="needsCheckModalWrap" onclick="needsCheckBackdropClose(event)">
      <div class="needs-check-modal" role="dialog" aria-modal="true" aria-labelledby="needsCheckModalTitle">
        <div class="needs-check-modal-head">
          <span aria-hidden="true">🔔</span>
          <strong id="needsCheckModalTitle">확인필요 작업</strong>
          <span class="needs-check-count" id="needsCheckModalCount">0</span>
          <button class="needs-check-modal-close" type="button" onclick="closeNeedsCheckModal()" aria-label="닫기">×</button>
        </div>
        <div class="needs-check-modal-list" id="needsCheckList"></div>
      </div>
    </div>`;
  s = s.replace(compactPanel, compactPanel + modal);
}

const startMarker = 'function renderNeedsCheck(grouped)';
const endMarker = '\nasync function loadLiveNotionData(){';
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker, start);
if(start < 0 || end < 0) throw new Error('needs-check runtime block not found');

const runtime = `function renderNeedsCheck(grouped){
  const panel=document.getElementById("needsCheckPanel");
  const list=document.getElementById("needsCheckList");
  const count=document.getElementById("needsCheckCount");
  const modalCount=document.getElementById("needsCheckModalCount");
  if(!panel||!list||!count)return;
  const items=getNeedsCheckTasks(grouped);
  liveNeedsCheckItems=items;
  count.textContent=items.length;
  if(modalCount) modalCount.textContent=items.length;
  panel.classList.toggle("hidden",items.length===0);
  list.innerHTML=items.length ? items.map(item=>\`<div class="needs-check-item" data-check-id="\${escapeHtml(item.id)}"><div class="needs-check-title">\${escapeHtml(item.title)}</div><div class="needs-check-meta">\${escapeHtml(item.project)} · \${escapeHtml(item.status||"상태 없음")}</div><div class="needs-check-actions"><button class="needs-check-btn needs-check-open" type="button" onclick='openNeedsCheckTask(\${JSON.stringify(item.id)})'>내용 보기</button><button class="needs-check-btn needs-check-done" type="button" onclick='confirmNeedsCheck(\${JSON.stringify(item.id)})'>확인 완료</button></div></div>\`).join("") : '<div class="empty">확인필요 작업이 없습니다.</div>';
  if(items.length===0) closeNeedsCheckModal();
}
function openNeedsCheckModal(){
  if(!liveNeedsCheckItems.length)return;
  document.getElementById("needsCheckModalWrap")?.classList.add("show");
  document.body.style.overflow="hidden";
}
function closeNeedsCheckModal(){
  document.getElementById("needsCheckModalWrap")?.classList.remove("show");
  document.body.style.overflow="";
}
function needsCheckBackdropClose(e){if(e.target?.id==="needsCheckModalWrap") closeNeedsCheckModal();}
function openNeedsCheckTask(id){
  const item=liveNeedsCheckItems.find(x=>x.id===id);
  if(!item)return;
  const detail=document.getElementById("modalWrap");
  if(detail) detail.classList.add("needs-check-detail");
  // 목록 팝업은 닫지 않는다. 상세 팝업을 그 위에 띄워 닫으면 목록으로 돌아오게 한다.
  openTask(item.title,item.project,item.status,item.priority,item.worker,item.desc,false);
}
function notifyNewNeedsCheck(grouped){
  const ids=getNeedsCheckTasks(grouped).map(x=>x.id).filter(Boolean);
  let seen=[];try{seen=JSON.parse(localStorage.getItem("dadNeedsCheckSeen")||"[]")}catch(e){}
  const fresh=ids.filter(id=>!seen.includes(id));if(!fresh.length)return;
  localStorage.setItem("dadNeedsCheckSeen",JSON.stringify([...new Set([...seen,...fresh])].slice(-300)));
  const t=document.getElementById("toast");if(t){t.textContent=\`🔔 새 확인필요 작업 \${fresh.length}건이 있습니다\`;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),3500)}
  if("Notification" in window&&Notification.permission==="granted"){try{new Notification("아빠 대시보드",{body:\`새 확인필요 작업 \${fresh.length}건이 있습니다\`})}catch(e){}}
}
async function confirmNeedsCheck(id){
  const btn=document.querySelector(\`[data-check-id="\${CSS.escape(id)}"] .needs-check-done\`);
  if(btn){btn.disabled=true;btn.textContent="처리 중…"}
  try{
    const res=await fetch("/api/check-task",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({id})});
    const payload=await res.json().catch(()=>({}));
    if(!res.ok||!payload.ok)throw new Error(payload.error||\`API \${res.status}\`);
    await loadLiveNotionData();
    const t=document.getElementById("toast");if(t){t.textContent="확인 완료 · 목록에서 제거했습니다";t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}
  }catch(e){
    if(btn){btn.disabled=false;btn.textContent="확인 완료"}
    const t=document.getElementById("toast");if(t){t.textContent="확인 처리에 실패했습니다";t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200)}
    console.error(e)
  }
}
`;

s = s.slice(0,start) + runtime + s.slice(end);
fs.writeFileSync(path,s);
console.log('needs-check compact summary + modal applied');
