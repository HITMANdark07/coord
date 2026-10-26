import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@wto/client";
import { localTransport } from "@wto/local-daemon";
import { createMcpServer } from "./server";

// Register with Claude Code:
//   claude mcp add wto -- pnpm --dir "<repo>/apps/mcp-server" --silent start
const server = createMcpServer(createClient(localTransport()));
await server.connect(new StdioServerTransport());
