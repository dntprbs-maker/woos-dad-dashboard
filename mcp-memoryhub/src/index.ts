#!/usr/bin/env node
// WOO'S 메모리허브 MCP — stdio 실행 진입점
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./tools.js";
import { migrateTaskAssignee } from "./task-assignee-migration.js";

await buildServer(migrateTaskAssignee).connect(new StdioServerTransport());
