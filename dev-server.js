#!/usr/bin/env node

/**
 * PolicyGate — Standalone dev bridge.
 *
 * Spawns the Python Executa as a stdio subprocess, serves the static bundle,
 * and exposes a /rpc endpoint so the browser UI can call the tool without Anna.
 *
 * Usage: node dev-server.js
 *        Then open http://localhost:3456
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");

const PORT = parseInt(process.env.PORT || "3456", 10);
const BUNDLE_DIR = path.resolve(__dirname, "bundle");
const PYTHON = process.env.PYTHON || "python3";
const PLUGIN_PATH = path.resolve(
  __dirname,
  "executas/policygate-case-python/policygate_case_plugin.py",
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

/* ── spawn Python Executa ── */
console.log("[dev-bridge] Spawning Python Executa …");
const proc = spawn(PYTHON, [PLUGIN_PATH], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

const rl = readline.createInterface({ input: proc.stdout });
const pending = new Map();

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  if (id && pending.has(id)) {
    pending.get(id)(msg);
    pending.delete(id);
  }
});

proc.on("exit", (code) => {
  console.error(`[dev-bridge] Python process exited with code ${code}`);
});

function rpcSend(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID().slice(0, 12);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("RPC timeout"));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(msg.error.message || "RPC error"));
      } else {
        resolve(msg.result);
      }
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// warm-up: describe tool on start
rpcSend("describe", {}).then((desc) => {
  console.log(`[dev-bridge] Executa connected: ${desc.display_name} v${desc.version}`);
}).catch((e) => {
  console.error(`[dev-bridge] Executa describe failed: ${e.message}`);
});

/* ── serve static files + RPC ── */
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // RPC endpoint
  if (req.method === "POST" && req.url === "/rpc") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { tool, method, args } = JSON.parse(body);
        const result = await rpcSend("invoke", {
          tool: tool || "case",
          arguments: args || {},
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // static files
  let filePath = path.join(BUNDLE_DIR, req.url === "/" ? "index.html" : req.url.replace(/^\//, ""));
  if (req.url === "/anna-tool-ids.js") {
    // inject the dev tool id
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(
      'window.__ANNA_TOOL_IDS__ = { "policygate-case": "tool-test-policygate-case-12345678" };\n',
    );
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`\n[dev-bridge] PolicyGate running at http://localhost:${PORT}\n`);
});

// graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[dev-bridge] Shutting down …");
  proc.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  proc.kill();
  process.exit(0);
});
