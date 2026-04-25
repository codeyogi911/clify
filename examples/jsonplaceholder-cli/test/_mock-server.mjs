// Zero-dep HTTP mock for integration tests.
// Contract: see references/conventions.md "Mock Server Contract".
import { createServer } from "node:http";

export async function mockApi(routes) {
  const requests = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let body = raw;
    if (ct.includes("application/json") && raw) {
      try { body = JSON.parse(raw); } catch { /* leave as string */ }
    }

    const urlObj = new URL(req.url, "http://placeholder");
    const path = urlObj.pathname;
    const captured = {
      method: req.method,
      path,
      query: Object.fromEntries(urlObj.searchParams.entries()),
      headers: { ...req.headers },
      body,
      raw,
    };
    requests.push(captured);

    const match = matchRoute(routes, req.method, path);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no mock route", method: req.method, path }));
      return;
    }

    let result = match.handler;
    if (typeof result === "function") {
      result = await result(captured, match.params);
    }

    const status = result.status ?? 200;
    const headers = { "content-type": "application/json", ...(result.headers || {}) };
    res.writeHead(status, headers);
    if (result.body === undefined || result.body === null) {
      res.end();
    } else if (typeof result.body === "string") {
      res.end(result.body);
    } else {
      res.end(JSON.stringify(result.body));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

function matchRoute(routes, method, path) {
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(/\s+/);
    if (routeMethod !== method) continue;
    const params = matchPath(routePath, path);
    if (params) return { handler, params };
  }
  return null;
}

function matchPath(template, actual) {
  const tParts = template.split("/").filter(Boolean);
  const aParts = actual.split("/").filter(Boolean);
  if (tParts.length !== aParts.length) return null;
  const params = {};
  for (let i = 0; i < tParts.length; i++) {
    if (tParts[i].startsWith(":")) {
      params[tParts[i].slice(1)] = decodeURIComponent(aParts[i]);
    } else if (tParts[i] !== aParts[i]) {
      return null;
    }
  }
  return params;
}
