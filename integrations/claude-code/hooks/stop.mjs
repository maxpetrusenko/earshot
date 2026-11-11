#!/usr/bin/env node
// Stop hook for running earshot from a checkout without installing it globally.
// Point a Stop hook at this file: node /path/to/earshot/integrations/claude-code/hooks/stop.mjs
// It needs `pnpm build` once. The real work is in src/hook/claude-code.ts.
await import("../../../dist/hook-entry.js");
