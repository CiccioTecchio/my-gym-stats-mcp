import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

function createServer(): McpServer {
  return new McpServer({
    name: "my-gym-stats-mcp",
    version: "1.0.0",
  });
}

serveStdio(createServer);

console.error("My Gym Stats MCP server running on stdio");
