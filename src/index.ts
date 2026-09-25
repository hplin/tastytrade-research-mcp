import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createResearchServer } from "./server.js";

const server = createResearchServer();
const transport = new StdioServerTransport();
await server.connect(transport);
