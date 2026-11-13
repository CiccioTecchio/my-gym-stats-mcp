import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { registerListLogbookFilesTool } from "./tools/list-logbook-files.js";
import { registerReadLogbookTools } from "./tools/read-logbook.js";

function createServer(): McpServer {
  const server = new McpServer({
    name: "my-gym-stats-mcp",
    version: "1.0.0",
  });

  registerListLogbookFilesTool(server);
  registerReadLogbookTools(server);

  return server;
}

serveStdio(createServer);

console.error("My Gym Stats MCP server running on stdio");
