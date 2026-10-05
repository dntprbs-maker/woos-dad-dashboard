// WOO'S 메모리허브 MCP — HTTP(Streamable, stateless) 진입점. Vercel 함수에서 호출한다.
// caller: 인증에 쓰인 키의 라벨(예: 초롱이). 알 수 없으면 null — 입력자를 추정하지 않는다.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";
import { runWithCaller } from "./context.js";

export async function handleMcp(req: any, res: any, body: unknown, caller: string | null = null) {
  await runWithCaller(caller, "http", async () => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}
