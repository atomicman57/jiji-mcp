#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./tools.mjs";
import { bridgeRequest } from "./bridge.mjs";
await createServer(bridgeRequest).connect(new StdioServerTransport());
