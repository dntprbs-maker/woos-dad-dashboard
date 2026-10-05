// 호출한 쪽이 상태코드로 바꿔 쓸 수 있는 오류.
//
// 공용 오류 타입. (원래 구형 REST의 ops.js에 있던 것을 옮겨 왔고, ops.js·projects.js는 2026-10-05 제거)

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
