// 호출한 쪽이 상태코드로 바꿔 쓸 수 있는 오류.
//
// ops.js 에 있던 것을 여기로 옮겼다. projects.js 도 같은 오류 타입을 써야 하는데,
// ops.js ↔ projects.js 가 서로를 import 하면 순환 참조가 되기 때문이다.
// ops.js 는 이 파일을 다시 export 하므로 기존 import 경로는 그대로 동작한다.

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
