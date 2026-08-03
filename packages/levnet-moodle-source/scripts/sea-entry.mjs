import { main } from "./server.mjs";

main().catch((error) => {
  console.error("Fatal error starting Levnet & Moodle Integration MCP server:", error);
  process.exit(1);
});
