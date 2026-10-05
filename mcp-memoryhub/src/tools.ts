// WOO'S 메모리허브 MCP — Notion 워크스페이스 통합 관리 (stdio)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as G from "./generic.js";
import * as W from "./woos.js";

export function buildServer() {
const server = new McpServer(
  { name: "woos-memoryhub", version: "1.0.0" },
  {
    instructions: [
      "WOO'S 메모리허브 MCP: 이 통합이 접근 권한을 가진 Notion 워크스페이스 전체를 조회·검색·생성·수정·이동·Relation·스키마·휴지통 처리한다.",
      "모든 쓰기 도구는 실행 후 다시 조회해 verified 값을 돌려준다. verified=false면 성공으로 보고하지 않는다.",
      "작업 원장: 등록 전 task_search, 실제 시작 즉시 task_start(→진행중), 진행 중 task_update, 끝낼 때 반드시 task_finish(종료 게이트·재조회 검증).",
      "완료(task_finish outcome=완료)는 삭제가 아니다. 휴지통은 trash_prepare(대상 재조회·승인토큰) → trash_execute(아빠의 명시적 삭제 지시 근거) 2단계로만 가능하며, 핵심 객체(운영규칙·작업 원장·직원·프로젝트 DB 등)는 MCP로 휴지통 처리할 수 없다.",
      "운영규칙 문서는 일반 쓰기 도구로 수정할 수 없고 rules_update(아빠 지시 문구 필수)로만 수정한다.",
      "AI는 우선순위를 상/중/하만 지정한다(최상·최하는 아빠 전용).",
    ].join("\n"),
  },
);

const ok = (data: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fail = (e: any) => ({ isError: true, content: [{ type: "text" as const, text: `오류: ${e?.message || e}` }] });
function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<any>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (a: any) => {
    try { return ok(await fn(a)); } catch (e) { return fail(e); }
  }) as any);
}
const Id = z.string().describe("Notion ID 또는 URL");
const Any = z.record(z.string(), z.any());
const Intervention = z.object({ type: z.enum(["없음", "의사결정", "직접조작"]), request: z.string().optional() });

// ═════════ 범용: 조회·검색 ═════════
tool("search", "워크스페이스 검색(제목). type으로 page/data_source 제한. scope_id를 주면 그 페이지/DB 하위로 한정, include_content=true면 범위 내 본문까지 검색(search_everything).", {
  query: z.string(), type: z.enum(["page", "data_source", "all"]).optional(), limit: z.number().optional(),
  scope_id: z.string().optional(), include_content: z.boolean().optional(), max_scan: z.number().optional(), include_trashed: z.boolean().optional(),
}, G.search);
tool("get", "페이지/DB/데이터소스/블록을 ID로 조회 — 종류·제목·부모·휴지통 여부·속성(DB 레코드면 단순값)·relation ID.", { id: Id }, G.get);
tool("get_content", "페이지 본문을 Markdown으로 조회 (하위 페이지/DB는 링크로 표시).", { id: Id, max_depth: z.number().optional(), max_blocks: z.number().optional() }, G.getContent);
tool("list_children", "하위 구조 조회: 페이지면 하위 페이지·DB, DB/데이터소스면 레코드 목록.", { id: Id }, G.listChildren);
tool("get_schema", "DB/데이터소스 스키마(속성·타입·선택지·relation 대상).", { id: Id }, G.getSchema);
tool("query", "DB 레코드 조건 조회. where={속성:값|[값..]|Notion조건객체}, filter=Notion 원형 필터, sorts=Notion 정렬.", {
  id: Id.describe("DB 또는 데이터소스 ID/URL"), where: Any.optional(), filter: z.any().optional(), sorts: z.array(z.any()).optional(),
  limit: z.number().optional(), include_properties: z.boolean().optional(),
}, G.query);

// ═════════ 범용: 생성·수정 ═════════
tool("create_page", "페이지 생성. parent_id가 페이지면 일반 하위 페이지, DB/데이터소스면 레코드(properties 단순값). content_markdown으로 본문 작성. 실검증용이면 test_object=true.", {
  parent_id: Id, title: z.string(), properties: Any.optional(), content_markdown: z.string().optional(), icon: z.string().optional(), test_object: z.boolean().optional(),
}, G.createPage);
tool("update_page", "페이지 제목·속성·아이콘 수정 후 재조회 검증. 속성값: 텍스트/숫자/select 이름/multi_select 배열/date 'YYYY-MM-DD' 또는 {start,end}/checkbox/relation ID 배열/null=비우기.", {
  id: Id, title: z.string().optional(), properties: Any.optional(), icon: z.string().nullable().optional(),
}, G.updatePage);
tool("write_content", "본문 수정: append(끝 또는 after_block_id 뒤에 Markdown 추가) / replace(하위 페이지·DB는 보존하고 나머지 본문 교체) / replace_text(그 글이 든 블록 1개의 텍스트 교체).", {
  id: Id, mode: z.enum(["append", "replace", "replace_text"]), markdown: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(), after_block_id: z.string().optional(),
}, (a) => G.writeContent(a));
tool("set_relation", "Relation 추가(add)·해제(remove)·전체지정(set) 후 재조회 검증.", {
  page_id: Id, property: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), set: z.array(z.string()).optional(),
}, G.setRelation);
tool("create_database", "페이지 아래 DB 생성. properties 예: {\"이름\":\"title\",\"상태\":{\"select\":[\"a\",\"b\"]},\"점수\":\"number\",\"연결\":{\"relation\":\"<데이터소스ID>\"}}", {
  parent_page_id: Id, title: z.string(), properties: Any, test_object: z.boolean().optional(),
}, G.createDatabase);
tool("update_schema", "DB/데이터소스 스키마 수정: add(속성 추가), rename({옛:새}), remove(속성 삭제), change_options({속성:[선택지..]}), title.", {
  id: Id, title: z.string().optional(), add: Any.optional(), rename: z.record(z.string(), z.string()).optional(), remove: z.array(z.string()).optional(), change_options: z.record(z.string(), z.array(z.string())).optional(),
}, G.updateSchema);
tool("move", "페이지를 다른 페이지/DB 아래로, DB(또는 그 데이터소스)를 다른 페이지 아래로 이동 후 부모 재조회 검증.", { id: Id, new_parent_id: Id }, G.move);

// ═════════ 범용: 휴지통·검증 ═════════
tool("trash_prepare", "휴지통 1단계: 대상(최대 20건)의 현재 제목·종류·부모·포함 항목 수를 재조회하고 승인토큰 발급. 보호 객체는 거부. 실행하지 않음.", { ids: z.array(z.string()) }, G.trashPrepare);
tool("trash_execute", "휴지통 2단계: prepare의 승인토큰 + 승인 근거로 실제 휴지통 처리 → 재조회로 in_trash 검증. 기존 데이터는 approved_by='아빠' + 아빠의 실제 삭제 지시 문구 필수. 이 MCP가 test_object로 만든 객체만 approval='테스트 객체 정리'로 처리 가능.", {
  approval_token: z.string(), approval: z.string().describe("아빠의 실제 삭제 지시 문구, 또는 '테스트 객체 정리'"), approved_by: z.string(),
}, G.trashExecute);
tool("restore", "휴지통에서 복원 후 재조회 검증.", { id: Id }, G.restore);
tool("verify_change", "변경 후 재조회 검증: 제목·휴지통 여부·부모·속성값·본문 포함 문자열을 기대값과 비교.", {
  id: Id, expect: z.object({ title: z.string().optional(), in_trash: z.boolean().optional(), parent_id: z.string().optional(), properties: Any.optional(), content_contains: z.array(z.string()).optional() }),
}, G.verifyChange);
tool("api_request", "Notion REST 원형 호출(GET/POST/PATCH, DELETE는 /blocks/{id} 본문 블록 삭제만; /v1 제외 경로). 페이지·DB 휴지통 처리·운영규칙 수정은 막혀 있음. 다른 도구로 안 되는 경우에만.", {
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]), path: z.string(), body: z.any().optional(),
}, G.apiRequest);

tool("upload_file", "로컬 파일(최대 20MB)을 Notion에 업로드. attach_to(페이지 ID)를 주면 그 페이지 본문 끝에 image/pdf/file 블록으로 첨부하고 재조회 검증.", {
  path: z.string().optional().describe("로컬 파일 경로(이 PC에서 실행할 때)"), content_base64: z.string().optional().describe("원격 실행 시 파일 내용(base64)"), filename: z.string().optional(), attach_to: z.string().optional(), caption: z.string().optional(),
}, G.uploadFile);

// ═════════ WOO'S: 작업 원장 ═════════
tool("task_search", "작업 원장 검색. 기본은 미완료 전체(완료 제외). include_done_days=7이면 최근 7일 완료 포함.", {
  query: z.string().optional(), status: z.union([z.string(), z.array(z.string())]).optional(), include_done_days: z.number().optional(),
  project: z.string().optional(), worker: z.string().optional(), limit: z.number().optional(),
}, W.taskSearch);
tool("task_get", "작업 상세(작업내용·결정사항·관련파일·커밋·개입 등 인수인계 기록 전체).", { id: Id }, W.taskGet);
tool("task_create", "새 작업 등록. 먼저 기존 작업(미완료+최근7일 완료)을 자동 검색해 유사 후보가 있으면 생성하지 않고 후보를 돌려준다(강제 생성 없음). 작업명에 [프로젝트명] 자동 부착, 프로젝트 관계 자동 연결, 우선순위는 상/중/하만.", {
  project: z.string(), title: z.string(), content: z.string(), status: z.enum(["미착수", "진행중", "계획·아이디어"]).optional(), priority: z.enum(["상", "중", "하"]).optional(),
  worker: z.string().optional(), requester: z.string().optional(), distinct_from: z.object({ ids: z.array(z.string()), reason: z.string() }).optional(), extra: Any.optional(), test_object: z.boolean().optional(),
}, W.taskCreate);
tool("task_start", "작업 시작: 기존 기록 확인(반환) → 상태=진행중 + 시작 기록 → 재조회로 진행중 반영 검증. 완료 작업은 reopen_completed 필요.", {
  id: Id, note: z.string(), worker: z.string().optional(), reopen_completed: z.boolean().optional(),
}, W.taskStart);
tool("task_update", "진행 중 기록: progress(작업내용에 시각과 함께 덧붙임)·decision·files·commits·note, priority(상/중/하), intervention(아빠 개입 없음/의사결정/직접조작+요청내용). 상태는 바꾸지 않음.", {
  id: Id, progress: z.string().optional(), decision: z.string().optional(), files: z.string().optional(), commits: z.string().optional(), note: z.string().optional(),
  priority: z.enum(["상", "중", "하"]).optional(), intervention: Intervention.optional(),
}, W.taskUpdate);
tool("task_finish", "종료 게이트: 현재 작업 재조회 → 결과·검증·미해결·다음 단계 기록 → outcome(완료/진행중/대기/보류)을 규칙대로 검사(완료는 검증 필수, 대기는 외부조건, 보류는 의도적 중단) → 원장 수정 → 재조회로 상태·완료일시·기록 일치 검증.", {
  id: Id, outcome: z.enum(["완료", "진행중", "대기", "보류"]), result: z.string(), verification: z.string().optional(), unresolved: z.string().optional(),
  next_steps: z.string().optional(), waiting_for: z.string().optional(), hold_reason: z.string().optional(), files: z.string().optional(), commits: z.string().optional(),
  needs_dad_confirmation: z.boolean().optional(), dad_confirmed: z.string().optional(), intervention: Intervention.optional(),
}, W.taskFinish);

// ═════════ WOO'S: 운영규칙·작업일지·직원 ═════════
tool("rules_get", "운영규칙 문서 읽기(Markdown). doc: 운영규칙(기본)/실행·종료/정체성/개발 주의사항. section으로 제목 일부 필터.", { doc: z.string().optional(), section: z.string().optional() }, W.rulesGet);
tool("rules_update", "운영규칙 수정 — 아빠의 명시적 지시가 있을 때만. dad_instruction에 실제 지시 문구 필수. append_section(Markdown 추가) 또는 replace_text.", {
  doc: z.string().optional(), dad_instruction: z.string(), mode: z.enum(["append_section", "replace_text"]), markdown: z.string().optional(), old_text: z.string().optional(), new_text: z.string().optional(),
}, W.rulesUpdate);
tool("worklog_get", "날짜별 작업일지 조회 (date=YYYY-MM-DD, 기본 오늘 KST).", { date: z.string().optional() }, W.worklogGet);
tool("worklog_write", "날짜별 작업일지에 Markdown 덧붙이기. 없으면 create_if_missing=true로 생성.", { date: z.string().optional(), markdown: z.string(), create_if_missing: z.boolean().optional(), test_object: z.boolean().optional() }, W.worklogWrite);
tool("employee_find", "직원·에이전트 조회 (id, 또는 name/category(=구분)/status(=상태) 조건).", { id: z.string().optional(), name: z.string().optional(), category: z.string().optional().describe("구분"), status: z.string().optional().describe("상태") }, (a: any) => W.employeeFind({ id: a.id, name: a.name, 구분: a.category, 상태: a.status }));
tool("employee_update", "직원·에이전트 속성 수정 후 재조회 검증.", { id: Id, properties: Any }, W.employeeUpdate);

return server;
}
