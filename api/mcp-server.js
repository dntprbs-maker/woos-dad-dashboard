// Remote MCP 서버 (Streamable HTTP 전송)
//
//   POST /api/mcp            JSON-RPC 2.0 요청
//   POST /api/mcp/<키>       헤더를 못 넣는 클라이언트용 (ChatGPT 커넥터 등)
//   GET  /api/mcp            405 — 서버가 먼저 말을 거는 스트림은 쓰지 않는다
//
// 상태를 들고 있지 않다(stateless). 서버리스에서 인스턴스가 갈려도 상관없다.
// 실제 동작은 _lib/ops.js — REST API(/api/v1)와 완전히 같은 코드를 쓴다.
//
// 인증: Authorization: Bearer <TASKS_API_KEY> 또는 경로 마지막 조각에 키.
// 비밀값은 로그에 남기지 않는다.

import { authenticate, newRequestId, readJson, log } from "./_lib/http.js";
import { NotionError } from "./_lib/notion.js";
import {
  ApiError, getSchemaInfo, listTasks, searchTasks, createTask, getTask, updateTask, archiveTask
} from "./_lib/ops.js";
import { getRules, updateRules } from "./_lib/rules.js";
import { listProjects, getProject, updateProject, getProjectSchema } from "./_lib/projects.js";
import {
  checkMessages, listMessages, getMessage, sendMessage,
  updateMessage, markMessages, archiveMessage, getMessengerSchema,
  STATUS_NEW, STATUS_SEEN, STATUS_DONE
} from "./_lib/messages.js";
import {
  getAgentStatus, listAgentStatus, upsertAgentStatus, getAgentStatusSchema, STATES as AGENT_STATES
} from "./_lib/agentStatus.js";

const SERVER_INFO = { name: "woos-tasks", title: "공용 작업관리", version: "1.4.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

// 초롱이를 비롯한 클라이언트가 연결 직후 읽는 운영 규칙.
const INSTRUCTIONS = [
  "Notion `작업·업무협업` DB를 여러 AI가 함께 쓰는 공용 작업 원장이다.",
  "",
  "**작업관리 관련 작업을 시작하기 전에 get_notion_rules 를 호출해 최신 `노션 운영규칙`을 확인한다.**",
  "규칙의 원본은 그 노션 페이지 하나뿐이다. 네 프롬프트에 적힌 내용보다 그쪽이 우선한다.",
  "",
  "**update_notion_rules 는 아빠가 명시적으로 규칙 변경을 지시했을 때만 쓴다.**",
  "ChatGPT·Claude·Claude Code 어느 쪽도 스스로의 판단으로 운영규칙을 바꾸면 안 된다.",
  "규칙이 잘못됐다고 생각되면 고치지 말고 아빠에게 알리고 지시를 기다린다.",
  "",
  "지켜야 할 순서:",
  "1. 새 작업을 만들기 전에 반드시 search_tasks 로 기존 작업을 먼저 확인한다.",
  "2. 비슷한 작업이 있으면 create_task 대신 update_task 로 기존 작업을 갱신한다.",
  "3. create_task 가 duplicate_candidates 로 거절하면 force 로 다시 시도하지 말고,",
  "   후보를 사람에게 보여 주고 어느 작업을 갱신할지 물어본다.",
  "4. 진행 상황은 update_task 의 appendProgress 로 덧붙인다. 기존 내용을 지우지 않는다.",
  "5. 작업을 끝냈으면 update_task 에 complete=true 를 준다 (상태=완료 + 완료일시 기록).",
  "",
  "조회는 전부 서버에서 걸린다. 전체를 받아오지 말고 조건을 줘라.",
  "기본 중복검색 범위는 상태!=완료 이고, 최근 완료까지 봐야 하면 scope=both 를 쓴다.",
  "상태는 대기/진행중/완료/보류, 우선순위는 상/중/하 다.",
  "",
  "프로젝트 원장 (Notion `📁 프로젝트` DB):",
  "- 어떤 프로젝트의 현재 상황을 알아야 하면 작업을 훑지 말고 get_project 를 먼저 부른다.",
  "  개요·현재상태·주의사항·GitHub·TODO 링크와 미완료 작업, 최근 완료 작업을 한 번에 돌려준다.",
  "- 프로젝트 구분의 정본은 프로젝트 관계(projectRef)다. 프로젝트명 텍스트는 호환용이다.",
  "  create_task 에 project(이름)만 줘도 서버가 같은 이름의 프로젝트를 찾아 관계를 자동으로 채운다.",
  "- 작업을 마감해서 프로젝트 전체 상황이 달라졌으면 update_project 로 `현재상태`도 같이 갱신한다.",
  "  이 문구가 오래되면 다른 AI가 프로젝트를 잘못 판단한다.",
  "",
  "AI 공용 대화방 (AI 메신저):",
  "**대화방을 읽고 쓰는 것은 이 도구로만 한다.** 공식 Notion MCP로 대화방 페이지를 직접",
  "만들거나 고치지 마라. 그렇게 등록된 메시지는 속성이 비어 받는 쪽 조회에서 빠진다.",
  "",
  "- 「띵동」을 받으면 check_messages 에 자기 이름(me)을 주고 미처리 수신함을 확인한다.",
  "- **자기 이름을 정확히 쓴다.** `해리`(헤르메스)와 `Claude Code`는 서로 다른 AI다.",
  "  남 앞으로 온 지시를 대신 처리하지 마라.",
  "- 메시지를 읽으면 update_message 로 상태를 `확인`(처리 중) → `처리완료`(끝)로 바꾼다.",
  "  이게 읽음 표시이자 안 읽은 메시지를 구분하는 유일한 방법이다.",
  "- **상태는 받는 쪽이 관리한다.** 내가 보낸 메시지의 상태는 수신자가 바꾼다. 내가 바꾸지 않는다.",
  "- 답장은 상태 변경이 아니라 send_message 로 만드는 새 메시지다.",
  "- send_message 는 발신자·수신자·제목·내용이 하나라도 비면 등록을 거절한다.",
  "  내용을 본문에만 적는 것은 등록이 아니다.",
  "- check_messages 결과에 malformed 가 있으면 규칙을 어기고 등록된 메시지다.",
  "  본문을 읽어 내 것인지 판단하고, 남의 것이면 손대지 말고 보낸 쪽에 알린다.",
  "",
  "AI 실행상태 + heartbeat (AI 메신저와 별개 체계):",
  "- 'Claude Code 지금 작업 중이야?' 같은 질문은 get_agent_status(ai=\"Claude Code\")로 확인한다.",
  "  실행상태 값만 보지 말고 lastActivityAgeSeconds/stale/suspectedHung 을 함께 본다 —",
  "  60초(기본)가 넘으면 상태가 작업중이어도 정지·응답없음 의심으로 본다.",
  "- 여러 AI를 한 번에 보려면 list_agent_status."
].join("\n");

/* -------------------------------------------------------------- 도구 정의 */

const TASK_FIELD_PROPS = {
  title: { type: "string", description: "작업명" },
  description: { type: "string", description: "작업내용" },
  status: { type: "string", enum: ["대기", "진행중", "완료", "보류"], description: "상태" },
  priority: { type: "string", enum: ["상", "중", "하"], description: "우선순위" },
  project: { type: "string", description: "프로젝트명 (텍스트). 생성 시 같은 이름의 프로젝트가 원장에 있으면 관계가 자동으로 연결된다" },
  projectRef: {
    type: "array",
    items: { type: "string" },
    description: "프로젝트 관계 — 📁 프로젝트 페이지 UUID 배열. 프로젝트 구분의 정본이다. 보통은 project(이름)만 주면 서버가 알아서 채운다"
  },
  assignee: { type: "string", description: "작업자 (아빠/초롱이/별이/Claude Code/Codex/김영재/사람/기타)" },
  requester: { type: "string", description: "의뢰자" },
  enteredBy: { type: "string", description: "입력자 — 이 작업을 등록한 AI나 사람" },
  decision: { type: "string", description: "결정사항" },
  note: { type: "string", description: "비고" },
  commit: { type: "string", description: "Git Commit" },
  relatedFiles: { type: "string", description: "관련파일" },
  workDate: { type: "string", description: "작업일 (YYYY-MM-DD)" },
  duration: { type: "string", description: "작업시간" },
  collabType: { type: "string", enum: ["단독 작업", "공동 작업"], description: "협업형태" },
  needsCheck: { type: "boolean", description: "확인필요" }
};

const TOOLS = [
  {
    name: "search_tasks",
    title: "유사 작업 검색",
    description:
      "제목·내용이 비슷한 기존 작업을 찾는다. 새 작업을 만들기 전에 반드시 먼저 부를 것. " +
      "기본 범위는 상태!=완료이고, 최근 완료된 것까지 보려면 scope=both 를 준다.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "찾으려는 작업 제목" },
        description: { type: "string", description: "작업내용 (있으면 정확도가 올라간다)" },
        project: { type: "string", description: "프로젝트명" },
        scope: {
          type: "string",
          enum: ["open", "recent-done", "both", "all"],
          description: "open=미완료만(기본) / recent-done=최근 완료 / both=둘 다 / all=전체"
        },
        completedWithinDays: { type: "integer", description: "recent-done·both에서 최근 며칠 (기본 7)" },
        threshold: { type: "number", description: "유사도 임계값 0~1 (기본 0.6)" },
        limit: { type: "integer", description: "최대 결과 수 (기본 10)" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "list_tasks",
    title: "작업 조건 조회",
    description:
      "조건에 맞는 작업을 조회한다. 조건은 전부 Notion 서버에서 걸리므로 전체를 받아오지 말 것. " +
      "미완료 목록은 open=true, 최근 완료는 status=완료 + completedSince=7d.",
    inputSchema: {
      type: "object",
      properties: {
        open: { type: "boolean", description: "true면 상태!=완료만" },
        status: { type: "string", description: "쉼표 구분. 예: 진행중,대기" },
        statusNot: { type: "string", description: "쉼표 구분 제외 상태" },
        q: { type: "string", description: "작업명 부분일치" },
        project: { type: "string", description: "프로젝트명 부분일치 (텍스트)" },
        projectId: { type: "string", description: "프로젝트 관계로 거르기 — 📁 프로젝트 페이지 UUID. 텍스트보다 이쪽이 정확하다" },
        assignee: { type: "string", description: "작업자" },
        priority: { type: "string", description: "상/중/하" },
        completedSince: { type: "string", description: "완료일시 이후. '7d' 또는 '2026-08-20'" },
        workDateSince: { type: "string" },
        workDateUntil: { type: "string" },
        updatedSince: { type: "string", description: "최종수정 이후" },
        sort: { type: "string", description: "예: -완료일시 / -last_edited_time" },
        limit: { type: "integer", description: "기본 25, 최대 100" },
        cursor: { type: "string", description: "다음 페이지 커서" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "get_task",
    title: "작업 단건 조회",
    description: "작업 ID로 한 건을 자세히 본다. blocks=true면 페이지 본문까지 가져온다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        blocks: { type: "boolean", description: "본문까지 볼지" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "create_task",
    title: "신규 작업 생성",
    description:
      "새 작업을 만든다. 내부적으로 유사 작업을 먼저 찾아 비슷한 게 있으면 만들지 않고 거절한다. " +
      "거절당하면 force로 우기지 말고 update_task 로 기존 작업을 갱신할 것.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        ...TASK_FIELD_PROPS,
        content: { type: "string", description: "페이지 본문에 넣을 텍스트" },
        force: { type: "boolean", description: "중복검사를 건너뛴다. 사람이 명시적으로 시켰을 때만." }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "update_task",
    title: "기존 작업 수정",
    description:
      "기존 작업의 상태·진행내용·결정사항 등을 고친다. " +
      "appendProgress 는 기존 내용을 지우지 않고 시각 도장과 함께 뒤에 덧붙인다. " +
      "complete=true 면 상태=완료 + 완료일시를 한 번에 기록한다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        ...TASK_FIELD_PROPS,
        completedAt: { type: "string", description: "완료일시 (ISO)" },
        complete: { type: "boolean", description: "true면 상태=완료 + 완료일시=현재시각" },
        appendProgress: { type: "string", description: "진행내용을 덧붙인다" },
        appendTo: {
          type: "string",
          description: "덧붙일 대상 속성명. 보통 'description'. 생략하면 페이지 본문에 기록"
        }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "archive_task",
    title: "작업 보관",
    description:
      "작업을 노션 휴지통으로 보낸다. 복구할 수 있지만 목록에서는 사라진다. " +
      "사람이 명시적으로 시켰을 때만 쓸 것.",
    inputSchema: {
      type: "object",
      required: ["id", "confirm"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        confirm: { type: "boolean", description: "true 여야 실행된다" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_schema",
    title: "DB 스키마 조회",
    description: "대상 작업 DB의 속성 목록과 선택지를 본다. 어떤 값을 넣을 수 있는지 확인할 때.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  // ── 프로젝트 원장 (📁 프로젝트 DB) ──────────────────────────────────────
  {
    name: "list_projects",
    title: "프로젝트 목록",
    description:
      "프로젝트 원장의 목록을 본다. 어떤 프로젝트가 있는지, 각각 어떤 상태인지 한눈에 볼 때. " +
      "상태는 진행중/보류/자동화완료/관리대상 아님.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "쉼표 구분. 예: 진행중,보류" },
        q: { type: "string", description: "프로젝트명 부분일치" },
        limit: { type: "integer", description: "기본 50, 최대 100" },
        cursor: { type: "string", description: "다음 페이지 커서" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "get_project",
    title: "프로젝트 현황 한 번에 보기",
    description:
      "프로젝트 한 건의 개요·현재상태·주의사항·GitHub·TODO 링크와 함께 " +
      "그 프로젝트의 미완료 작업과 최근 완료 작업을 한 번에 돌려준다. " +
      "특정 프로젝트가 지금 어떤 상황인지 알아야 할 때는 작업 목록을 훑지 말고 이걸 먼저 부를 것.",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", description: "프로젝트명 또는 프로젝트 페이지 UUID" },
        openLimit: { type: "integer", description: "미완료 작업 최대 건수 (기본 30)" },
        doneLimit: { type: "integer", description: "최근 완료 작업 최대 건수 (기본 10)" },
        doneWithinDays: { type: "integer", description: "최근 완료를 며칠까지 볼지 (기본 30)" },
        blocks: { type: "boolean", description: "프로젝트 페이지 본문까지 가져올지" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "update_project",
    title: "프로젝트 원장 갱신",
    description:
      "프로젝트의 현재상태·개요·주의사항 등을 갱신한다. " +
      "작업을 마감해서 프로젝트 전체 상황이 달라졌으면 여기까지 갱신할 것. " +
      "현재상태 문구가 오래되면 다른 AI가 그 프로젝트를 잘못 판단한다.",
    inputSchema: {
      type: "object",
      required: ["project"],
      properties: {
        project: { type: "string", description: "프로젝트명 또는 프로젝트 페이지 UUID" },
        currentState: { type: "string", description: "현재상태 — 지금 이 프로젝트가 어디까지 와 있는지" },
        overview: { type: "string", description: "개요" },
        caution: { type: "string", description: "주의사항" },
        summary: { type: "string", description: "한줄소개" },
        status: {
          type: "string",
          enum: ["진행중", "보류", "자동화완료", "관리대상 아님"],
          description: "프로젝트 상태"
        },
        github: { type: "string", description: "GitHub 주소" },
        todo: { type: "string", description: "TODO 링크" },
        stampDate: { type: "boolean", description: "true면 현재상태 끝에 오늘 날짜를 붙인다" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_project_schema",
    title: "프로젝트 DB 스키마 조회",
    description: "프로젝트 원장 DB의 속성 목록과 선택지를 본다. 어떤 값을 넣을 수 있는지 확인할 때.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  // ── 노션 운영규칙 (Single Source of Truth) ──────────────────────────────
  {
    name: "get_notion_rules",
    title: "노션 운영규칙 조회",
    description:
      "Notion `노션 운영규칙` 페이지의 최신 내용을 읽는다. " +
      "작업관리 관련 작업(조회·검색·생성·수정·마감)을 시작하기 전에 반드시 먼저 호출할 것. " +
      "규칙의 원본은 이 페이지 하나이며, 프롬프트에 적힌 오래된 사본보다 항상 우선한다.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "update_notion_rules",
    title: "노션 운영규칙 변경",
    description:
      "`노션 운영규칙` 내용을 추가·수정·삭제한다. 변경 후 다시 읽어 실제 반영 여부를 검증해 돌려준다. " +
      "⚠️ 아빠가 명시적으로 운영규칙 변경을 지시했을 때만 사용한다. " +
      "AI(ChatGPT·Claude·Claude Code 등)가 스스로의 판단만으로 운영규칙을 바꾸면 안 된다. " +
      "규칙이 잘못돼 보이면 직접 고치지 말고 아빠에게 알리고 지시를 기다릴 것. " +
      "mode=replace 는 기존 내용을 전부 지우고 새로 쓰므로 특히 조심한다.",
    inputSchema: {
      type: "object",
      required: ["content", "dadApproved", "reason"],
      properties: {
        content: { type: "string", description: "규칙 본문. 줄 단위 마크다운(#, ##, -, 1.)을 인식한다" },
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description: "replace=전체 교체(수정·삭제) / append=뒤에 덧붙이기(추가). 기본 replace"
        },
        dadApproved: {
          type: "boolean",
          description: "아빠가 명시적으로 규칙 변경을 지시한 경우에만 true. 네 판단으로 true를 넣지 마라"
        },
        reason: { type: "string", description: "아빠가 무엇을 지시했는지 (변경 이력용, 5자 이상)" },
        passphrase: { type: "string", description: "워크스페이스가 암구호를 요구하는 경우 아빠께 받아서 전달" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  // ── AI 공용 대화방 (AI 메신저) ─────────────────────────────────────────
  {
    name: "check_messages",
    title: "내 미처리 메시지 확인",
    description:
      "AI 공용 대화방에서 나에게 온 미처리 메시지를 확인한다. 「띵동」을 받으면 이걸 먼저 부른다. " +
      "me 에 자기 이름을 정확히 넣을 것 — `해리`(헤르메스)와 `Claude Code`는 다른 AI다. " +
      "남 앞으로 온 지시를 대신 처리하면 안 된다. " +
      "속성이 비어 누구 것인지 알 수 없는 메시지는 malformed 로 따로 알려 준다.",
    inputSchema: {
      type: "object",
      required: ["me"],
      properties: {
        me: { type: "string", description: "내 이름. 예: 'Claude Code'. 대화방 수신자 선택지에 있는 이름이어야 한다" },
        limit: { type: "integer", description: "최대 건수 (기본 50)" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "list_messages",
    title: "대화방 조건 조회",
    description:
      "대화방 메시지를 조건으로 조회한다. 지난 스레드를 되짚어 볼 때 쓴다. " +
      "내 할 일을 확인하는 용도로는 check_messages 를 쓸 것.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "쉼표 구분. 예: 새메시지,확인" },
        sender: { type: "string", description: "발신자" },
        recipient: { type: "string", description: "수신자" },
        q: { type: "string", description: "제목 부분일치" },
        relatedTask: { type: "string", description: "관련작업 부분일치" },
        limit: { type: "integer", description: "기본 25, 최대 100" },
        cursor: { type: "string", description: "다음 페이지 커서" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "get_message",
    title: "메시지 단건 조회",
    description: "메시지 한 건을 본문까지 가져온다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "Notion 페이지 UUID" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "send_message",
    title: "메시지 보내기",
    description:
      "대화방에 메시지를 등록한다. 작업 결과 보고와 지시 전달 모두 이걸로 한다. " +
      "발신자·수신자·제목·내용이 하나라도 비면 등록을 거절한다 — 속성이 빈 메시지는 " +
      "받는 쪽 조회에서 빠져 묻히기 때문이다. 내용을 본문에만 적는 것은 등록이 아니다. " +
      "상태는 서버가 `새메시지`로 넣는다. 보내는 쪽이 정하지 않는다.",
    inputSchema: {
      type: "object",
      required: ["sender", "recipients", "title", "body"],
      properties: {
        sender: { type: "string", description: "발신자 — 자기 이름" },
        recipients: {
          type: "array",
          items: { type: "string" },
          description: "수신자 목록. 모두에게 보내려면 ['전체']"
        },
        title: { type: "string", description: "제목" },
        body: { type: "string", description: "내용 — 실제 메시지 본문" },
        relatedTask: { type: "string", description: "관련작업 (작업명과 UUID). 선택" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "update_message",
    title: "메시지 수정 · 읽음 처리",
    description:
      "메시지를 고친다. 주로 읽음 표시(상태 전이)에 쓴다: `확인`=처리 중, `처리완료`=끝. " +
      "**상태는 받는 쪽이 관리한다.** 내가 보낸 메시지의 상태는 수신자가 바꾼다. 내가 바꾸지 않는다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        status: {
          type: "string",
          enum: [STATUS_NEW, STATUS_SEEN, STATUS_DONE],
          description: "상태"
        },
        title: { type: "string", description: "제목" },
        body: { type: "string", description: "내용" },
        sender: { type: "string", description: "발신자" },
        recipients: { type: "array", items: { type: "string" }, description: "수신자 목록" },
        relatedTask: { type: "string", description: "관련작업" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "mark_messages",
    title: "여러 메시지 상태 일괄 변경",
    description: "여러 건의 상태를 한 번에 바꾼다. 끝난 스레드를 통째로 닫을 때 쓴다.",
    inputSchema: {
      type: "object",
      required: ["ids", "status"],
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Notion 페이지 UUID 배열" },
        status: { type: "string", enum: [STATUS_NEW, STATUS_SEEN, STATUS_DONE], description: "바꿀 상태" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "archive_message",
    title: "메시지 보관",
    description:
      "메시지를 노션 휴지통으로 보낸다. 복구할 수 있지만 목록에서는 사라진다. " +
      "노션 API에는 완전 삭제가 없어 여기서 할 수 있는 건 보관까지다. " +
      "사람이 명시적으로 시켰을 때만 쓸 것.",
    inputSchema: {
      type: "object",
      required: ["id", "confirm"],
      properties: {
        id: { type: "string", description: "Notion 페이지 UUID" },
        confirm: { type: "boolean", description: "true 여야 실행된다" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: "get_messenger_schema",
    title: "대화방 DB 스키마 조회",
    description: "대화방 DB의 속성·선택지와 필수 항목을 본다. 쓸 수 있는 이름을 확인할 때.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  // ── AI 실행상태 + heartbeat (AI 메신저의 새메시지/확인 과는 별개 체계) ──
  {
    name: "get_agent_status",
    title: "AI 실행상태 조회 (heartbeat 나이 포함)",
    description:
      "특정 AI(예: Claude Code)가 지금 작업중/대기/완료/오류중단 중 무엇인지, " +
      "마지막 활동이 몇 초 전인지 한 번에 돌려준다. " +
      "'지금 작업 중이야? 마지막 활동 몇 초 전이야?' 류의 질문에 이걸 쓴다. " +
      "실행상태 값만 믿지 말고 lastActivityAgeSeconds/stale/suspectedHung 을 함께 볼 것 — " +
      "마지막 활동이 임계값(기본 60초)을 넘으면 상태가 작업중이어도 정지·응답없음 의심이다.",
    inputSchema: {
      type: "object",
      required: ["ai"],
      properties: {
        ai: { type: "string", description: "AI 이름. 예: 'Claude Code'" },
        staleSeconds: { type: "integer", description: "정지 의심 판정 임계값(초). 기본 60" }
      }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "list_agent_status",
    title: "전체 AI 실행상태 목록",
    description: "등록된 모든 AI의 실행상태를 heartbeat 나이와 함께 한 번에 본다.",
    inputSchema: {
      type: "object",
      properties: { staleSeconds: { type: "integer", description: "정지 의심 판정 임계값(초). 기본 60" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "update_agent_status",
    title: "AI 실행상태 갱신 / heartbeat",
    description:
      "AI 실행상태를 갱신한다. 호출할 때마다 마지막활동시간이 서버 시각으로 찍히므로 " +
      "이것 자체가 heartbeat다. status 없이 ai만 주면 순수 heartbeat(마지막활동시간만 갱신)이고, " +
      "기존 기록이 전혀 없는 첫 호출에는 status가 있어야 한다. " +
      "status=작업중으로 새로 들어가면 작업시작시간을 자동으로 지금으로 찍는다(이미 작업중이면 안 건드림). " +
      "status가 대기/완료/오류·중단이면 종료시각을 자동으로 지금으로 찍는다.",
    inputSchema: {
      type: "object",
      required: ["ai"],
      properties: {
        ai: { type: "string", description: "AI 이름. 예: 'Claude Code'" },
        status: { type: "string", enum: AGENT_STATES, description: "실행상태" },
        taskName: { type: "string", description: "현재 작업명" },
        sessionId: { type: "string", description: "실행 세션 식별자" },
        pid: { type: "string", description: "프로세스 PID" },
        note: { type: "string", description: "비고 (오류 메시지 등)" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: "get_agent_status_schema",
    title: "AI 실행상태 DB 스키마 조회",
    description: "AI 실행상태 DB의 속성·선택지·임계값을 본다.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  // ── ChatGPT 딥리서치 커넥터가 기대하는 이름 (search / fetch) ────────────
  {
    name: "search",
    title: "작업 검색",
    description:
      "작업 원장에서 키워드로 작업을 찾는다. 제목 부분일치와 유사도 검색을 함께 쓴다. " +
      "결과의 id 를 fetch 에 넣으면 전문을 볼 수 있다.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string", description: "찾을 키워드나 작업 제목" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  {
    name: "fetch",
    title: "작업 전문 가져오기",
    description: "search 가 돌려준 id 로 작업 한 건의 전문을 가져온다.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "작업 ID (Notion 페이지 UUID)" } }
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  }
];

/* -------------------------------------------------------------- 도구 실행 */

/** 작업 한 건을 사람이 읽을 수 있는 줄글로 (fetch 결과용) */
function taskToText(t) {
  const lines = [
    "작업명: " + (t.title || ""),
    t.status ? "상태: " + t.status : null,
    t.priority ? "우선순위: " + t.priority : null,
    t.project ? "프로젝트: " + t.project : null,
    t.assignee ? "작업자: " + t.assignee : null,
    t.requester ? "의뢰자: " + t.requester : null,
    t.workDate ? "작업일: " + t.workDate : null,
    t.completedAt ? "완료일시: " + t.completedAt : null,
    t.description ? "\n작업내용:\n" + t.description : null,
    t.decision ? "\n결정사항:\n" + t.decision : null,
    t.note ? "\n비고:\n" + t.note : null,
    t.commit ? "Git Commit: " + t.commit : null,
    Array.isArray(t.content) && t.content.length ? "\n본문:\n" + t.content.join("\n") : null
  ];
  return lines.filter(Boolean).join("\n");
}

async function runTool(name, args = {}) {
  switch (name) {
    case "search_tasks": return searchTasks(args);
    case "list_tasks":   return listTasks(args);
    case "get_task":     return getTask(args.id, { blocks: args.blocks === true });
    case "create_task":  return createTask(args);
    case "update_task": {
      const { id, ...rest } = args;
      return updateTask(id, rest);
    }
    case "archive_task": {
      if (args.confirm !== true) {
        throw new ApiError(400, "confirm_required", "보관하려면 confirm=true 를 줘야 합니다");
      }
      return archiveTask(args.id);
    }
    case "get_schema": return getSchemaInfo();

    case "list_projects": return listProjects(args);
    case "get_project":
      return getProject(args.project, {
        openLimit: args.openLimit,
        doneLimit: args.doneLimit,
        doneWithinDays: args.doneWithinDays,
        blocks: args.blocks === true
      });
    case "update_project": {
      const { project, ...rest } = args;
      return updateProject(project, rest);
    }
    case "get_project_schema": return getProjectSchema();

    case "check_messages": return checkMessages(args);
    case "list_messages":  return listMessages(args);
    case "get_message":    return getMessage(args.id);
    case "send_message":   return sendMessage(args);
    case "update_message": {
      const { id, ...rest } = args;
      return updateMessage(id, rest);
    }
    case "mark_messages":  return markMessages(args.ids, args.status);
    case "archive_message": {
      if (args.confirm !== true) {
        throw new ApiError(400, "confirm_required", "보관하려면 confirm=true 를 줘야 합니다");
      }
      return archiveMessage(args.id);
    }
    case "get_messenger_schema": return getMessengerSchema();

    case "get_agent_status": return getAgentStatus(args.ai, { staleSeconds: args.staleSeconds });
    case "list_agent_status": return listAgentStatus({ staleSeconds: args.staleSeconds });
    case "update_agent_status": return upsertAgentStatus(args);
    case "get_agent_status_schema": return getAgentStatusSchema();

    case "get_notion_rules": return getRules();
    case "update_notion_rules":
      return updateRules({
        mode: args.mode,
        content: args.content,
        dadApproved: args.dadApproved,
        reason: args.reason,
        passphrase: args.passphrase
      });

    case "search": {
      const query = String(args.query || "").trim();
      if (!query) throw new ApiError(400, "invalid_request", "query가 필요합니다");

      // 제목 부분일치와 유사도 검색을 합친다. 둘 다 서버측 필터를 거친다.
      const byTitle = await listTasks({ q: query, limit: 25 });
      const bySimilarity = await searchTasks({ title: query, scope: "both", threshold: 0.4, limit: 25 });

      const seen = new Set();
      const results = [];
      for (const t of [...byTitle.tasks, ...bySimilarity.matches]) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        results.push({
          id: t.id,
          title: t.title || "(제목 없음)",
          url: t.url,
          status: t.status ?? null,
          project: t.project ?? null
        });
      }
      return { results };
    }

    case "fetch": {
      const { task } = await getTask(args.id, { blocks: true });
      return {
        id: task.id,
        title: task.title || "(제목 없음)",
        text: taskToText(task),
        url: task.url,
        metadata: {
          status: task.status ?? null,
          priority: task.priority ?? null,
          project: task.project ?? null,
          assignee: task.assignee ?? null,
          workDate: task.workDate ?? null,
          completedAt: task.completedAt ?? null,
          last_edited_time: task.last_edited_time ?? null
        }
      };
    }

    default:
      throw new ApiError(404, "unknown_tool", "'" + name + "' 도구는 없습니다");
  }
}

/* ------------------------------------------------------------- JSON-RPC */

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message, data) => ({
  jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) }
});

const asToolResult = payload => ({
  content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload
});

const asToolError = (code, message, extra) => ({
  content: [{
    type: "text",
    text: JSON.stringify({ ok: false, code, error: message, ...(extra || {}) }, null, 2)
  }],
  isError: true
});

async function handleRpc(message) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL;
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS
    });
  }

  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") return rpcResult(id, { tools: TOOLS });

  // 능력으로 광고하지는 않지만, 넘겨짚고 부르는 클라이언트가 있어 빈 목록을 돌려준다.
  if (method === "resources/list")           return rpcResult(id, { resources: [] });
  if (method === "resources/templates/list") return rpcResult(id, { resourceTemplates: [] });
  if (method === "prompts/list")             return rpcResult(id, { prompts: [] });

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    try {
      return rpcResult(id, asToolResult(await runTool(toolName, args)));
    } catch (e) {
      // 도구 실행 실패는 프로토콜 오류가 아니라 도구 결과로 돌려준다.
      // 그래야 모델이 읽고 스스로 고쳐 다시 시도할 수 있다 (특히 중복 거절).
      if (e instanceof ApiError) return rpcResult(id, asToolError(e.code, e.message, e.extra));
      if (e instanceof NotionError) return rpcResult(id, asToolError("notion_" + e.code, e.message));
      console.error(JSON.stringify({ scope: "mcp_tool", tool: toolName, error: e.message }));
      return rpcResult(id, asToolError("internal_error", e.message));
    }
  }

  if (isNotification) return null; // notifications/* 등은 응답하지 않는다
  return rpcError(id, -32601, "지원하지 않는 메서드: " + method);
}

/* ------------------------------------------------------------ 엔트리포인트 */

// 헤더를 못 넣는 클라이언트를 위해 경로 마지막 조각의 키도 인증에 쓴다.
function withPathKey(req) {
  const url = new URL(req.url, "http://localhost");
  const fromRewrite = url.searchParams.get("mcpkey");
  const raw = fromRewrite !== null
    ? fromRewrite
    : url.pathname.replace(/^\/api\/mcp\/?/, "");

  const key = raw.split("/").filter(Boolean).pop();
  if (!key || req.headers.authorization || req.headers["x-api-key"]) return req;

  return new Proxy(req, {
    get(target, prop) {
      if (prop === "headers") return { ...target.headers, authorization: "Bearer " + key };
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}

export default async function handler(req, res) {
  const rid = newRequestId();
  const started = Date.now();

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  // 서버가 먼저 말을 거는 SSE 스트림은 제공하지 않는다. 스펙상 405가 정답이다.
  if (req.method === "GET") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "이 서버는 POST만 받습니다" } });
    return;
  }
  // 세션을 안 들고 있으므로 종료 요청은 그냥 받아준다.
  if (req.method === "DELETE") { res.status(204).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "POST만 받습니다" } });
    return;
  }

  const authed = withPathKey(req);
  const auth = authenticate(authed);
  if (!auth.ok) {
    log({ rid, method: "POST", route: "/api/mcp", status: auth.status, code: auth.code, ms: Date.now() - started });
    res.status(auth.status).json(rpcError(null, -32001, auth.error));
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    res.status(400).json(rpcError(null, -32700, e.message));
    return;
  }

  try {
    // 배치(JSON-RPC 배열)는 최신 스펙에서 빠졌지만 보내는 클라이언트가 있어 받아 준다.
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      log({ rid, method: "POST", route: "/api/mcp", status: out.length ? 200 : 202,
            ms: Date.now() - started, key: auth.label, code: "batch" });
      if (!out.length) { res.status(202).end(); return; }
      res.status(200).json(out);
      return;
    }

    const out = await handleRpc(body);
    log({ rid, method: "POST", route: "/api/mcp", status: out ? 200 : 202, code: body?.method,
          ms: Date.now() - started, key: auth.label });

    if (!out) { res.status(202).end(); return; } // 알림에는 본문 없이 202
    res.status(200).json(out);
  } catch (e) {
    console.error(JSON.stringify({ rid, scope: "mcp", error: e.message }));
    res.status(500).json(rpcError(body?.id ?? null, -32603, e.message));
  }
}
