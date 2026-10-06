// 실검증: 실제 MCP 프로토콜(stdio)로 서버를 띄워 새 테스트 객체만으로 전 기능을 검증하고, 끝나면 테스트 객체만 휴지통 처리한다.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_PARENT = process.env.WOOS_TEST_PARENT_ID || "3cf2d174-b03c-81ea-a810-c8d8f18668d5"; // 「초롱이 세팅」 아래에 임시 테스트 페이지를 만든다(통합이 접근 가능한 최상위 페이지)
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

const client = new Client({ name: "woos-selftest", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], env: process.env as any }));

const results: { step: string; ok: boolean; detail?: any }[] = [];
async function call(name: string, args: any): Promise<{ data?: any; error?: string }> {
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) return { error: text };
  return { data: JSON.parse(text) };
}
function rec(step: string, ok: boolean, detail?: any) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${ok ? "" : "  → " + JSON.stringify(detail).slice(0, 400)}`);
}
const created: string[] = [];

try {
  const tools = await client.listTools();
  rec("0. MCP 도구 목록", tools.tools.length >= 30, tools.tools.length);

  // 1·2. 페이지 생성 + 재조회
  const root = await call("create_page", { parent_id: TEST_PARENT, title: `🧪 [테스트] 메모리허브 MCP 실검증 ${stamp}`, content_markdown: "# 실검증용 임시 페이지\n자동 정리됩니다.", test_object: true });
  rec("1. 페이지 생성", !!root.data?.page?.id, root);
  const rootId = root.data.page.id; created.push(rootId);
  const g = await call("get", { id: rootId });
  rec("2. 생성 페이지 재조회", g.data?.title?.includes("메모리허브 MCP 실검증") && g.data.in_trash === false, g);

  // 3. 제목 수정
  const newTitle = `🧪 [테스트] 메모리허브 MCP 실검증 ${stamp} (수정됨)`;
  const ut = await call("update_page", { id: rootId, title: newTitle });
  rec("3. 제목 수정 + 재조회", ut.data?.verified === true && ut.data.page.title === newTitle, ut);

  // 4. 본문 수정 (append / replace_text / replace)
  const ap = await call("write_content", { id: rootId, mode: "append", markdown: "## 추가 섹션\n- 항목 A **굵게**\n  - 하위 항목\n- [ ] 할 일\n```js\nconsole.log(1)\n```" });
  const rt = await call("write_content", { id: rootId, mode: "replace_text", old_text: "항목 A", new_text: "항목 A2" });
  const c1 = await call("get_content", { id: rootId });
  rec("4. 본문 수정(append·replace_text) + 재조회", ap.data?.verified && rt.data?.verified && c1.data.markdown.includes("항목 A2") && c1.data.markdown.includes("하위 항목"), { ap, rt, md: c1.data?.markdown });

  // 하위 페이지 2개 (이동 시험용)
  const childA = await call("create_page", { parent_id: rootId, title: "테스트 하위 A", test_object: true });
  const childB = await call("create_page", { parent_id: rootId, title: "테스트 하위 B", test_object: true });
  created.push(childA.data.page.id, childB.data.page.id);

  // replace는 하위 페이지를 보존해야 함
  const rp = await call("write_content", { id: rootId, mode: "replace", markdown: "교체된 본문" });
  const c2 = await call("get_content", { id: rootId });
  rec("4b. 본문 전체 교체(하위 페이지 보존) + 재조회", rp.data?.preserved_child_pages_dbs?.length === 2 && c2.data.markdown.includes("교체된 본문") && !c2.data.markdown.includes("항목 A2"), { rp, md: c2.data?.markdown });

  // DB 2개 생성 (relation 시험용)
  const dbT = await call("create_database", { parent_page_id: rootId, title: "테스트 대상 DB", properties: { 이름: "title" }, test_object: true });
  const dsT = dbT.data.data_sources[0].id;
  const dbM = await call("create_database", { parent_page_id: rootId, title: "테스트 메인 DB", properties: { 이름: "title", 상태: { select: ["대기", "진행", "끝"] }, 점수: "number", 메모: "rich_text", 날짜: "date", 확인: "checkbox", 태그: { multi_select: ["x", "y"] }, 연결: { relation: dsT } }, test_object: true });
  rec("DB 생성(스키마 포함)", !!dbM.data?.database_id && !!dbT.data?.database_id, { dbM, dbT });
  const dsM = dbM.data.data_sources[0].id;
  created.push(dbT.data.database_id, dbM.data.database_id);

  // 스키마 수정
  const us = await call("update_schema", { id: dsM, add: { 링크: "url" }, rename: { 메모: "설명" }, change_options: { 상태: ["대기", "진행", "끝", "보류"] } });
  rec("스키마 수정(추가·이름변경·선택지) + 재조회", us.data?.verified === true && us.data.schema.properties["상태"].options.includes("보류"), us);

  // 6. DB 레코드 생성/수정
  const t1 = await call("create_page", { parent_id: dsT, title: "대상1", test_object: true });
  const t2 = await call("create_page", { parent_id: dbT.data.database_id, title: "대상2", test_object: true });
  const r1 = await call("create_page", { parent_id: dsM, title: "레코드1", properties: { 상태: "대기", 점수: 3, 설명: "처음", 날짜: "2026-10-05", 확인: false, 태그: ["x"] }, test_object: true });
  created.push(t1.data.page.id, t2.data.page.id, r1.data.page.id);
  rec("6a. DB 레코드 생성 + 재조회", r1.data?.page?.properties?.["상태"] === "대기" && r1.data.page.properties["점수"] === 3, r1);
  // 5. 속성 수정
  const r1u = await call("update_page", { id: r1.data.page.id, properties: { 상태: "진행", 점수: 7.5, 설명: "수정됨", 날짜: { start: "2026-10-06", end: "2026-10-07" }, 확인: true, 태그: ["x", "y"], 링크: "https://example.com" } });
  rec("5·6b. 속성(select/number/text/date/checkbox/multi/url) 수정 + 재조회", r1u.data?.verified === true, r1u);
  const badSel = await call("update_page", { id: r1.data.page.id, properties: { 상태: "없는값" } });
  rec("잘못된 select 값 거부", !!badSel.error, badSel);

  // 7. Relation 생성
  const rel1 = await call("set_relation", { page_id: r1.data.page.id, property: "연결", add: [t1.data.page.id, t2.data.page.id] });
  rec("7. Relation 생성 + 재조회", rel1.data?.verified === true && rel1.data.after.length === 2, rel1);
  // 8. Relation 해제
  const rel2 = await call("set_relation", { page_id: r1.data.page.id, property: "연결", remove: [t1.data.page.id] });
  const vrel = await call("verify_change", { id: r1.data.page.id, expect: { properties: { 연결: [t2.data.page.id] } } });
  rec("8. Relation 해제 + 재조회", rel2.data?.verified === true && rel2.data.after.length === 1 && vrel.data?.all_ok, { rel2, vrel });

  // 9. 페이지 이동 (B를 A 아래로) + DB 이동 (대상DB를 A 아래로)
  const mv = await call("move", { id: childB.data.page.id, new_parent_id: childA.data.page.id });
  const vmv = await call("verify_change", { id: childB.data.page.id, expect: { parent_id: childA.data.page.id } });
  rec("9. 페이지 이동 + 부모 재조회", mv.data?.verified === true && vmv.data?.all_ok, { mv, vmv });
  const mvdb = await call("move", { id: dbT.data.database_id, new_parent_id: childA.data.page.id });
  rec("9b. DB 이동 + 부모 재조회", mvdb.data?.verified === true, mvdb);
  const ls = await call("list_children", { id: childA.data.page.id });
  rec("하위 구조 조회", ls.data?.children?.some((c: any) => c.title === "테스트 하위 B") && ls.data.children.some((c: any) => c.kind === "database"), ls);

  // 10. 조건 검색
  const q = await call("query", { id: dsM, where: { 상태: "진행", 확인: true, 점수: { greater_than: 5 } } });
  const q0 = await call("query", { id: dsM, where: { 상태: "끝" } });
  const sch = await call("get_schema", { id: dbM.data.database_id });
  const s1 = await call("search", { query: `메모리허브 MCP 실검증 ${stamp}`, type: "page" });
  const s2 = await call("search", { query: "교체된 본문", scope_id: rootId, include_content: true });
  rec("10. 조건 검색(속성)·제목 검색·범위 본문 검색", q.data?.count === 1 && q0.data?.count === 0 && !!sch.data?.properties?.["연결"] && s2.data?.results?.some((r: any) => r.id === rootId), { q: q.data?.count, q0: q0.data?.count, s1: s1.data?.count, s2 });

  // 작업 원장 절차 (테스트 작업 1건으로)
  const tc = await call("task_create", { project: "master-project", title: `[테스트] 메모리허브 MCP 실검증용 임시 작업 ${stamp} — 자동 삭제 예정`, content: "MCP 실검증용 임시 작업 (테스트 종료 시 휴지통 처리)", status: "미착수", priority: "하", assignee: "코드디", distinct_from: { ids: [], reason: "실검증용 임시 객체" }, test_object: true });
  let taskId = tc.data?.task?.id;
  if (!taskId && tc.data?.duplicate_candidates) {
    const tc2 = await call("task_create", { project: "master-project", title: `[테스트] 메모리허브 MCP 실검증용 임시 작업 ${stamp} — 자동 삭제 예정`, content: "MCP 실검증용 임시 작업", status: "미착수", priority: "하", assignee: "코드디", distinct_from: { ids: tc.data.duplicate_candidates.map((c: any) => c.id), reason: "실검증용 임시 객체라 기존 작업과 무관" }, test_object: true });
    taskId = tc2.data?.task?.id;
    rec("task_create 중복 후보 감지 후 distinct_from로 등록", !!taskId, { tc, tc2 });
  } else rec("task_create (제목 [프로젝트] 부착·프로젝트 연결)", !!taskId && tc.data.task.작업명.startsWith("[master-project]") && tc.data.project_linked, tc);
  created.push(taskId);
  await new Promise((r) => setTimeout(r, 8000)); // Notion 조회 인덱스 반영 대기
  const dup = await call("task_create", { project: "master-project", title: `[테스트] 메모리허브 MCP 실검증용 임시 작업 ${stamp} — 자동 삭제 예정`, content: "중복", test_object: true });
  if (dup.data?.task?.id) created.push(dup.data.task.id);
  rec("중복 작업 생성 거부", dup.data?.created === false && dup.data.duplicate_candidates.some((c: any) => c.id === taskId), dup);
  const badPri = await call("task_update", { id: taskId, priority: "최상" });
  rec("AI의 최상 우선순위 지정 거부", !!badPri.error, badPri);
  const st = await call("task_start", { id: taskId, note: "실검증 시작" });
  rec("start_work: 미착수→진행중 + 재조회", st.data?.verified === true && st.data.status_before === "미착수" && st.data.status_after === "진행중", st);
  const up = await call("task_update", { id: taskId, progress: "중간 진행 기록", decision: "테스트 결정", intervention: { type: "의사결정", request: "테스트용 개입 요청" } });
  const up2 = await call("task_update", { id: taskId, intervention: { type: "없음" } });
  rec("진행 기록·아빠 개입 설정/해제 + 재조회", up.data?.verified && up2.data?.verified, { up, up2 });
  const g1 = await call("task_finish", { id: taskId, outcome: "완료", result: "결과만 있음" });
  const g2 = await call("task_finish", { id: taskId, outcome: "대기", result: "x", waiting_for: "다음 지시를 기다림" });
  const g3 = await call("task_finish", { id: taskId, outcome: "완료", result: "x", verification: "검증했다고 주장함 길게 씀", needs_dad_confirmation: true });
  rec("종료 게이트: 검증 없는 완료·'다음 지시' 대기·아빠확인 전 완료 거부", g1.data?.gate === "rejected" && g2.data?.gate === "rejected" && g3.data?.gate === "rejected", { g1, g2, g3 });
  const f1 = await call("task_finish", { id: taskId, outcome: "대기", result: "외부 응답 필요", waiting_for: "테스트 외부 서비스 응답", next_steps: "응답 오면 재개" });
  rec("finish_work: 대기 + 재조회 일치", f1.data?.verified === true && f1.data.task.상태 === "대기", f1);
  const st2 = await call("task_start", { id: taskId, note: "외부 응답 수신, 재개" });
  const f2 = await call("task_finish", { id: taskId, outcome: "완료", result: "실검증 완료", verification: "selftest 스크립트로 상태·완료일시 재조회 일치 확인" });
  rec("finish_work: 완료 + 완료일시·재조회 일치", st2.data?.verified && f2.data?.verified === true && f2.data.task.상태 === "완료" && !!f2.data.task.완료일시, f2);
  const ts = await call("task_search", { query: `실검증용 임시 작업 ${stamp}`, include_done_days: 1 });
  rec("task_search(최근 완료 포함)", ts.data?.tasks?.some((t: any) => t.id === taskId), ts);
  // 담당자 통일: 출력은 「담당자」만(구형 「작업자」 키 없음), 입력은 assignee 공식 + worker alias
  const t0 = ts.data?.tasks?.find((t: any) => t.id === taskId);
  rec("담당자 출력: 「담당자」 키 있음·구형 「작업자」 키 없음", Array.isArray(t0?.담당자) && t0.담당자.includes("코드디") && !("작업자" in t0), t0);
  const sa = await call("task_search", { assignee: "코드디", query: `실검증용 임시 작업 ${stamp}`, include_done_days: 1 });
  const sw = await call("task_search", { worker: "코드디", query: `실검증용 임시 작업 ${stamp}`, include_done_days: 1 });
  rec("담당자 검색: assignee·worker(alias) 모두 「담당자」 relation 기준으로 동일 결과", sa.data?.tasks?.some((t: any) => t.id === taskId) && sw.data?.tasks?.some((t: any) => t.id === taskId), { sa, sw });
  const sx = await call("task_search", { assignee: "코드디", worker: "해리", include_done_days: 1 });
  rec("assignee·worker 값이 다르면 거부", !!sx.error, sx);
  const tg = await call("task_get", { id: taskId });
  rec("task_get: 「담당자」 키만", Array.isArray(tg.data?.task?.담당자 ?? tg.data?.담당자) && !("작업자" in (tg.data?.task ?? tg.data ?? {})), tg);

  // 날짜별 작업일지: 실제 일지는 읽기만, 쓰기는 존재하지 않는 날짜(2099-01-01) 시험 일지로
  const wlToday = await call("worklog_get", { date: "2026-10-04" });
  rec("worklog_get(실제 일지 읽기)", wlToday.data?.exists === true && wlToday.data.markdown.length > 50, wlToday.data?.title);
  const wl0 = await call("worklog_get", { date: "2099-01-01" });
  const wlNo = await call("worklog_write", { date: "2099-01-01", markdown: "x" });
  const wl1 = await call("worklog_write", { date: "2099-01-01", markdown: "## 실검증\n- 첫 기록", create_if_missing: true, test_object: true });
  if (wl1.data?.id) created.push(wl1.data.id);
  const wl2 = await call("worklog_write", { date: "2099-01-01", markdown: "- 두 번째 기록" });
  const wl3 = await call("worklog_get", { date: "2099-01-01" });
  rec("worklog_write(없으면 거부·생성·추가) + 재조회", wl0.data?.exists === false && !!wlNo.error && wl1.data?.created && wl1.data.verified && wl2.data?.created === false && wl2.data.verified && wl3.data?.markdown.includes("첫 기록") && wl3.data.markdown.includes("두 번째 기록"), { wl0, wlNo, wl1, wl2, wl3 });

  // 운영규칙·안전장치
  const rg = await call("rules_get", { section: "작업 원장 사용 절차" });
  rec("rules_get(섹션)", rg.data?.markdown?.includes("종료 게이트"), rg.data?.markdown?.slice(0, 200));
  const rw = await call("update_page", { id: "3c92d174-b03c-81c3-bff4-c95cb9ef0585", title: "x" });
  const rw2 = await call("write_content", { id: "3c92d174-b03c-81c3-bff4-c95cb9ef0585", mode: "append", markdown: "x" });
  const ru = await call("rules_update", { dad_instruction: "", mode: "append_section", markdown: "x" });
  rec("운영규칙 일반 수정 차단·아빠 지시 없는 rules_update 거부", !!rw.error && !!rw2.error && !!ru.error, { rw, rw2, ru });
  const pp = await call("trash_prepare", { ids: ["3c82d174b03c81fd8802e661400a4f53"] });
  rec("보호 객체(작업 원장 DB) 휴지통 거부", !!pp.error, pp);
  const raw = await call("api_request", { method: "PATCH", path: `/pages/${childA.data.page.id}`, body: { in_trash: true } });
  rec("api_request로 휴지통 우회 차단", !!raw.error, raw);
  // 테스트 객체가 아닌 것(기존 운영 데이터)을 '테스트 객체 정리'로 지우려는 시도 → 거부 (실행 전 단계에서 막혀 데이터 손상 없음)
  const pr0 = await call("trash_prepare", { ids: ["3d02d174-b03c-81e4-9538-fd82c03bf24a"] });
  const ex0 = pr0.data ? await call("trash_execute", { approval_token: pr0.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" }) : { error: "prepare 실패" };
  rec("기존 운영 데이터를 승인 없이 휴지통 처리 거부", !!ex0.error && /테스트 객체/.test(ex0.error), { pr0: pr0.error || "ok", ex0 });
  const v0 = await call("get", { id: "3d02d174-b03c-81e4-9538-fd82c03bf24a" });
  rec("기존 운영 데이터 무손상 확인", v0.data?.in_trash === false, v0.data?.in_trash);
  const reuse = pr0.data ? await call("trash_execute", { approval_token: pr0.data.approval_token, approval: "아빠가 지우라고 함", approved_by: "아빠" }) : { error: "x" };
  rec("사용된 승인토큰 재사용 거부", !!reuse.error, reuse);

  // 11. 페이지 휴지통 (하위 B, 단건) + 복원 + 재휴지통
  const pB = await call("trash_prepare", { ids: [childB.data.page.id] });
  const eB = await call("trash_execute", { approval_token: pB.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" });
  const vB = await call("verify_change", { id: childB.data.page.id, expect: { in_trash: true } });
  rec("11. 페이지 휴지통 + 재조회 in_trash", eB.data?.all_verified === true && vB.data?.all_ok, { pB, eB, vB });
  const rs = await call("restore", { id: childB.data.page.id });
  rec("복원 + 재조회", rs.data?.verified === true, rs);
  // DB 레코드 휴지통
  const pR = await call("trash_prepare", { ids: [t1.data.page.id] });
  const eR = await call("trash_execute", { approval_token: pR.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" });
  rec("DB 레코드 휴지통 + 재조회", eR.data?.all_verified === true, eR);
  // 12. DB/데이터소스 휴지통
  const pD = await call("trash_prepare", { ids: [dbT.data.database_id] });
  const eD = await call("trash_execute", { approval_token: pD.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" });
  const pS = await call("trash_prepare", { ids: [dsM] });
  const eS = await call("trash_execute", { approval_token: pS.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" });
  rec("12. DB 휴지통 + 데이터소스 휴지통 + 재조회", eD.data?.all_verified === true && eS.data?.all_verified === true, { pD, eD, pS, eS });
} catch (e: any) {
  rec("예외", false, e?.message || String(e));
} finally {
  // 정리: 테스트 루트 페이지(하위 전부 포함)와 작업 원장의 테스트 작업만 휴지통 처리
  const toTrash: string[] = [];
  for (const id of created.filter(Boolean)) {
    const g = await call("get", { id });
    if (!g.data || g.data.in_trash) continue;
    const inLedger = g.data.parent?.type === "data_source_id" && String(g.data.parent.id).replace(/-/g, "") === "8ba2d174b03c8369b0a207b234b93430";
    const inWorklog = String(g.data.parent?.id || "").replace(/-/g, "") === "3d92d174b03c8176a25df400af461614";
    if (id === created[0] || inLedger || inWorklog) toTrash.push(id);
  }
  if (toTrash.length) {
    const p = await call("trash_prepare", { ids: toTrash });
    const e = p.data ? await call("trash_execute", { approval_token: p.data.approval_token, approval: "테스트 객체 정리", approved_by: "코드디" }) : p;
    rec("13. 정리: 테스트 루트 페이지·테스트 작업·시험 일지 휴지통 + 재조회", !!e.data?.all_verified, e);
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - fails.length}/${results.length} 통과`);
  await client.close();
  process.exit(fails.length ? 1 : 0);
}
