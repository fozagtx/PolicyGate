/**
 * Anna App SDK — Dev shim.
 *
 * When running outside Anna (via the dev bridge), this shim replaces
 * AnnaAppRuntime with a web-compatible proxy that routes tool calls
 * to the local dev-server /rpc endpoint.
 *
 * The real Anna platform loads its own SDK at this path; this file
 * only runs when the dev bridge serves it.
 */
const DEV_RPC_URL = "/rpc";

async function rpcCall(toolId, method, args) {
  const res = await fetch(DEV_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool: toolId, method, args }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data || json;
}

const storage = new Map();

export class AnnaAppRuntime {
  static async connect() {
    const inst = new AnnaAppRuntime();
    // warm-up: verify the tool is alive
    await rpcCall("case", "get_state", {});
    return inst;
  }

  tools = {
    invoke: async ({ tool_id, method, args }) => {
      const result = await rpcCall(tool_id, method, args);
      return result;
    },
  };

  storage = {
    get: async ({ key }) => {
      return storage.get(key) ?? null;
    },
    set: async ({ key, value }) => {
      storage.set(key, value);
    },
  };

  chat = {
    write_message: async ({ role, content }) => {
      console.log(`[dev-shim] chat.write_message (${role}):`, content);
    },
  };

  window = {
    set_title: async ({ title }) => {
      document.title = title;
    },
  };
}