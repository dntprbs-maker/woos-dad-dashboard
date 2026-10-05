// 호출자(어느 AI가 이 MCP를 부르는지) 컨텍스트.
// - stdio(이 PC): 실행 설정의 환경변수 WOOS_CALLER (예: 코드디, 덱스디)
// - HTTP(원격): api/memoryhub.js가 인증에 쓰인 키의 라벨로 지정 (예: 초롱이)
// 호출자를 알 수 없으면 null — 추정해서 채우지 않는다.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<{ caller: string | null; transport: "stdio" | "http" }>();

export function runWithCaller<T>(caller: string | null, transport: "stdio" | "http", fn: () => T): T {
  return store.run({ caller: caller?.trim() || null, transport }, fn);
}

export function currentCaller(): string | null {
  const s = store.getStore();
  if (s) return s.caller;
  return process.env.WOOS_CALLER?.trim() || null;
}

export function currentTransport(): "stdio" | "http" {
  return store.getStore()?.transport ?? "stdio";
}
