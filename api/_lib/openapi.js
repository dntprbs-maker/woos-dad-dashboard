// ChatGPT Actions / 기타 도구가 바로 물릴 수 있게 OpenAPI 3.1 문서를 제공한다.
// 비밀값은 들어가지 않는다. 서버 URL은 요청 헤더에서 유추한다.

function baseUrl(req) {
  if (process.env.TASKS_API_BASE_URL) return process.env.TASKS_API_BASE_URL.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  return proto + "://" + host;
}

const TASK = {
  type: "object",
  properties: {
    id: { type: "string", description: "Notion 페이지 UUID" },
    url: { type: "string" },
    title: { type: "string", description: "작업명" },
    description: { type: "string", nullable: true, description: "작업내용" },
    status: { type: "string", nullable: true, description: "대기 / 진행중 / 완료 / 보류" },
    priority: { type: "string", nullable: true, description: "상 / 중 / 하" },
    project: { type: "string", nullable: true, description: "프로젝트명" },
    assignee: { type: "string", nullable: true, description: "작업자" },
    requester: { type: "string", nullable: true, description: "의뢰자" },
    enteredBy: { type: "string", nullable: true, description: "입력자" },
    decision: { type: "string", nullable: true, description: "결정사항" },
    note: { type: "string", nullable: true, description: "비고" },
    commit: { type: "string", nullable: true, description: "Git Commit" },
    relatedFiles: { type: "string", nullable: true, description: "관련파일" },
    workDate: { type: "string", nullable: true, description: "작업일 (ISO)" },
    completedAt: { type: "string", nullable: true, description: "완료일시 (ISO)" },
    duration: { type: "string", nullable: true, description: "작업시간" },
    collabType: { type: "string", nullable: true, description: "협업형태" },
    needsCheck: { type: "boolean", nullable: true, description: "확인필요" },
    last_edited_time: { type: "string" },
    score: { type: "number", description: "유사도 검색 결과에만 포함 (0~1)" },
    matchedOn: { type: "string", description: "유사도 근거" }
  }
};

const TASK_FIELDS = {
  title: { type: "string", description: "작업명 (필수)" },
  description: { type: "string", description: "작업내용" },
  status: { type: "string", description: "대기 / 진행중 / 완료 / 보류" },
  priority: { type: "string", description: "상 / 중 / 하" },
  project: { type: "string", description: "프로젝트명 (텍스트). 생성 시 같은 이름이 원장에 있으면 프로젝트 관계가 자동으로 연결된다" },
  projectRef: {
    type: "array",
    items: { type: "string" },
    description: "프로젝트 관계 — 📁 프로젝트 페이지 UUID 배열. 프로젝트 구분의 정본"
  },
  assignee: { type: "string", description: "작업자" },
  requester: { type: "string", description: "의뢰자" },
  enteredBy: { type: "string", description: "입력자 — 이 작업을 등록한 AI/사람" },
  decision: { type: "string", description: "결정사항" },
  note: { type: "string", description: "비고" },
  commit: { type: "string", description: "Git Commit" },
  relatedFiles: { type: "string", description: "관련파일" },
  workDate: { type: "string", description: "작업일 (YYYY-MM-DD 또는 ISO)" },
  completedAt: { type: "string", description: "완료일시 (ISO)" },
  duration: { type: "string", description: "작업시간" },
  collabType: { type: "string", description: "단독 작업 / 공동 작업" },
  needsCheck: { type: "boolean", description: "확인필요" }
};

const PROJECT = {
  type: "object",
  description: "프로젝트 원장 한 건 (Notion 📁 프로젝트 DB)",
  properties: {
    id: { type: "string", description: "Notion 페이지 UUID" },
    url: { type: "string" },
    name: { type: "string", description: "프로젝트명" },
    status: { type: "string", nullable: true, description: "진행중 / 보류 / 자동화완료 / 관리대상 아님" },
    summary: { type: "string", nullable: true, description: "한줄소개" },
    overview: { type: "string", nullable: true, description: "개요" },
    currentState: { type: "string", nullable: true, description: "현재상태" },
    caution: { type: "string", nullable: true, description: "주의사항" },
    github: { type: "string", nullable: true },
    todo: { type: "string", nullable: true, description: "TODO 링크" },
    last_edited_time: { type: "string" }
  }
};

export function openapi(req) {
  return {
    openapi: "3.1.0",
    info: {
      title: "공용 작업관리 API",
      version: "1.0.0",
      description:
        "Notion 작업 DB를 여러 AI가 함께 쓰는 공용 원장 API. " +
        "새 작업을 만들기 전에 반드시 유사 작업을 먼저 확인하고, 기존 작업이 있으면 새로 만들지 말고 수정한다. " +
        "POST /tasks 는 내부적으로 유사 검색을 먼저 돌려 중복이면 409를 돌려준다."
    },
    servers: [{ url: baseUrl(req) + "/api/v1" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "TASKS_API_KEY 값" }
      },
      schemas: {
        Task: TASK,
        Project: PROJECT,
        Error: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            code: { type: "string" },
            error: { type: "string" },
            candidates: { type: "array", items: TASK }
          }
        }
      }
    },
    paths: {
      "/tasks": {
        get: {
          operationId: "listTasks",
          summary: "조건으로 작업 조회 (서버측 필터. 전체를 받아오지 않는다)",
          parameters: [
            { name: "open", in: "query", schema: { type: "boolean" }, description: "true면 상태 != 완료 (기본 중복검색 조건)" },
            { name: "status", in: "query", schema: { type: "string" }, description: "쉼표 구분. 예: 진행중,대기" },
            { name: "statusNot", in: "query", schema: { type: "string" }, description: "쉼표 구분 제외 상태" },
            { name: "q", in: "query", schema: { type: "string" }, description: "작업명 부분일치" },
            { name: "project", in: "query", schema: { type: "string" }, description: "프로젝트명 부분일치 (텍스트)" },
            { name: "projectId", in: "query", schema: { type: "string" }, description: "프로젝트 관계로 거르기 — 📁 프로젝트 페이지 UUID" },
            { name: "assignee", in: "query", schema: { type: "string" }, description: "작업자" },
            { name: "priority", in: "query", schema: { type: "string" }, description: "상/중/하" },
            { name: "completedSince", in: "query", schema: { type: "string" }, description: "완료일시 >= 값. '7d' 또는 날짜" },
            { name: "workDateSince", in: "query", schema: { type: "string" } },
            { name: "workDateUntil", in: "query", schema: { type: "string" } },
            { name: "updatedSince", in: "query", schema: { type: "string" }, description: "최종수정 >= 값" },
            { name: "sort", in: "query", schema: { type: "string" }, description: "예: -완료일시,작업명 / -last_edited_time" },
            { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "다음 페이지 커서" }
          ],
          responses: {
            200: {
              description: "조회 결과",
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  count: { type: "integer" },
                  has_more: { type: "boolean" },
                  next_cursor: { type: "string", nullable: true },
                  tasks: { type: "array", items: TASK }
                }
              } } }
            }
          }
        },
        post: {
          operationId: "createTask",
          summary: "신규 작업 생성 (내부적으로 유사 작업 검색 후 중복이면 409)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["title"],
              properties: {
                ...TASK_FIELDS,
                content: { type: "string", description: "페이지 본문에 넣을 텍스트 (빈 줄로 문단 구분)" },
                force: { type: "boolean", default: false, description: "true면 중복검사를 건너뛰고 강제로 만든다" },
                duplicateCheck: {
                  type: "object",
                  description: "중복검사 옵션. false를 주면 검사 안 함",
                  properties: {
                    scope: { type: "string", enum: ["open", "recent-done", "both", "all"], default: "open" },
                    threshold: { type: "number", default: 0.6 },
                    completedWithinDays: { type: "integer", default: 7 },
                    maxScan: { type: "integer", default: 300 }
                  }
                }
              }
            } } }
          },
          responses: {
            201: { description: "생성됨", content: { "application/json": { schema: {
              type: "object",
              properties: { ok: { type: "boolean" }, created: { type: "boolean" }, task: TASK }
            } } } },
            409: {
              description: "비슷한 기존 작업이 있음 — 새로 만들지 말고 기존 작업을 PATCH 할 것",
              content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } }
            }
          }
        }
      },
      "/tasks/search": {
        post: {
          operationId: "searchSimilarTasks",
          summary: "제목·내용 기준 유사 작업 검색 (새 작업 만들기 전 중복 확인용)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["title"],
              properties: {
                title: { type: "string", description: "찾으려는 작업 제목" },
                description: { type: "string" },
                project: { type: "string" },
                scope: {
                  type: "string",
                  enum: ["open", "recent-done", "both", "all"],
                  default: "open",
                  description: "open=상태!=완료(기본) / recent-done=최근 완료 / both=둘 다 / all=전체"
                },
                completedWithinDays: { type: "integer", default: 7 },
                threshold: { type: "number", default: 0.6 },
                limit: { type: "integer", default: 10, maximum: 50 },
                maxScan: { type: "integer", default: 300, description: "서버가 훑는 최대 건수. 넘으면 truncated=true" }
              }
            } } }
          },
          responses: {
            200: { description: "유사도 순 정렬 결과", content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                scope: { type: "string" },
                threshold: { type: "number" },
                scanned: { type: "integer" },
                truncated: { type: "boolean" },
                count: { type: "integer" },
                matches: { type: "array", items: TASK }
              }
            } } } }
          }
        }
      },
      "/tasks/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: "getTask",
          summary: "작업 단건 조회",
          parameters: [{ name: "blocks", in: "query", schema: { type: "boolean" }, description: "true면 페이지 본문도 함께" }],
          responses: { 200: { description: "작업", content: { "application/json": { schema: {
            type: "object", properties: { ok: { type: "boolean" }, task: TASK }
          } } } } }
        },
        patch: {
          operationId: "updateTask",
          summary: "기존 작업 수정 (진행내용·결정사항·상태 갱신)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ...TASK_FIELDS,
                title: { type: "string", description: "작업명" },
                complete: { type: "boolean", description: "true면 상태=완료 + 완료일시=현재시각" },
                appendProgress: { type: "string", description: "진행내용을 덧붙인다. 시각 도장이 붙는다" },
                appendTo: { type: "string", description: "덧붙일 텍스트 속성명. 생략하면 페이지 본문에 기록" },
                archived: { type: "boolean", description: "true면 보관(휴지통)" }
              }
            } } }
          },
          responses: { 200: { description: "수정됨", content: { "application/json": { schema: {
            type: "object", properties: { ok: { type: "boolean" }, updated: { type: "boolean" }, task: TASK }
          } } } } }
        },
        delete: {
          operationId: "archiveTask",
          summary: "작업 보관 (노션 휴지통으로. 복구 가능)",
          parameters: [{ name: "confirm", in: "query", required: true, schema: { type: "string", enum: ["true"] } }],
          responses: { 200: { description: "보관됨" } }
        }
      },
      "/projects": {
        get: {
          operationId: "listProjects",
          summary: "프로젝트 원장 목록 (어떤 프로젝트가 있고 각각 어떤 상태인지)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" }, description: "쉼표 구분. 진행중/보류/자동화완료/관리대상 아님" },
            { name: "q", in: "query", schema: { type: "string" }, description: "프로젝트명 부분일치" },
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } }
          ],
          responses: { 200: { description: "프로젝트 목록", content: { "application/json": { schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              count: { type: "integer" },
              projects: { type: "array", items: PROJECT }
            }
          } } } } }
        }
      },
      "/projects/schema": {
        get: {
          operationId: "getProjectSchema",
          summary: "프로젝트 원장 DB의 속성 목록과 선택지",
          responses: { 200: { description: "스키마" } }
        }
      },
      "/projects/{project}": {
        parameters: [{
          name: "project", in: "path", required: true, schema: { type: "string" },
          description: "프로젝트명 또는 프로젝트 페이지 UUID"
        }],
        get: {
          operationId: "getProject",
          summary: "프로젝트 현황을 한 번에 (개요·현재상태·주의사항 + 미완료 작업 + 최근 완료 작업)",
          parameters: [
            { name: "openLimit", in: "query", schema: { type: "integer", default: 30 } },
            { name: "doneLimit", in: "query", schema: { type: "integer", default: 10 } },
            { name: "doneWithinDays", in: "query", schema: { type: "integer", default: 30 } },
            { name: "blocks", in: "query", schema: { type: "boolean" }, description: "true면 프로젝트 페이지 본문도" }
          ],
          responses: { 200: { description: "프로젝트 현황", content: { "application/json": { schema: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              project: PROJECT,
              openTasks: { type: "array", items: TASK },
              recentlyDone: { type: "array", items: TASK }
            }
          } } } } }
        },
        patch: {
          operationId: "updateProject",
          summary: "프로젝트 현재상태 등 갱신 (작업 마감 시 함께 갱신할 것)",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                currentState: { type: "string", description: "현재상태" },
                overview: { type: "string", description: "개요" },
                caution: { type: "string", description: "주의사항" },
                summary: { type: "string", description: "한줄소개" },
                status: { type: "string", description: "진행중 / 보류 / 자동화완료 / 관리대상 아님" },
                github: { type: "string" },
                todo: { type: "string", description: "TODO 링크" },
                stampDate: { type: "boolean", description: "true면 현재상태 끝에 오늘 날짜를 붙인다" }
              }
            } } }
          },
          responses: { 200: { description: "수정됨" } }
        }
      },
      "/schema": {
        get: {
          operationId: "getSchema",
          summary: "대상 DB의 속성 목록과 선택지, 정규 필드 매핑",
          responses: { 200: { description: "스키마" } }
        }
      },
      "/health": {
        get: {
          operationId: "health",
          summary: "상태 확인 (인증 불필요)",
          security: [],
          responses: { 200: { description: "정상" } }
        }
      }
    }
  };
}
