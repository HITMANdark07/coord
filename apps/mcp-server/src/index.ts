import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "@coord/client";
import { localTransport } from "@coord/local-daemon";
import { createMcpServer } from "./server";

// Register with Claude Code:
//   claude mcp add coord -- pnpm --dir "<repo>/apps/mcp-server" --silent start
const server = createMcpServer(createClient(localTransport()));
await server.connect(new StdioServerTransport());
