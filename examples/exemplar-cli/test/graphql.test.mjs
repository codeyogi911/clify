// GraphQL substrate tests. The exemplar remains REST-shaped, but generated
// GraphQL-first CLIs inherit these helpers and dispatcher conventions.
import test from "node:test";
import assert from "node:assert/strict";
import { mockApi } from "./_mock-server.mjs";
import { showActionHelp } from "../lib/help.mjs";

async function importApiFor(serverUrl) {
  process.env.EXEMPLAR_API_KEY = "test-token";
  process.env.EXEMPLAR_BASE_URL = serverUrl;
  return await import(`../lib/api.mjs?graphql-test=${Date.now()}-${Math.random()}`);
}

test("graphqlRequest posts through the shared apiRequest layer", async () => {
  const server = await mockApi({
    "POST /graphql": (req) => {
      assert.equal(req.headers.authorization, "Bearer test-token");
      assert.equal(req.body.query, "query Shop { shop { name } }");
      assert.deepEqual(req.body.variables, { first: 1 });
      return { status: 200, body: { data: { shop: { name: "Exemplar" } } } };
    },
  });
  try {
    const { graphqlRequest } = await importApiFor(server.url);
    const result = await graphqlRequest({
      path: "/graphql",
      query: "query Shop { shop { name } }",
      variables: { first: 1 },
      version: "0.0.0-test",
    });
    assert.equal(result.shop.name, "Exemplar");
  } finally {
    await server.close();
    delete process.env.EXEMPLAR_API_KEY;
    delete process.env.EXEMPLAR_BASE_URL;
  }
});

test("paginateGraphql walks pageInfo connections", async () => {
  const server = await mockApi({
    "POST /graphql": (req) => {
      const after = req.body.variables.after;
      if (!after) {
        return {
          status: 200,
          body: {
            data: {
              products: {
                nodes: [{ id: "p1" }, { id: "p2" }],
                pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              },
            },
          },
        };
      }
      assert.equal(after, "cursor-2");
      return {
        status: 200,
        body: {
          data: {
            products: {
              nodes: [{ id: "p3" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    },
  });
  try {
    const { paginateGraphql } = await importApiFor(server.url);
    const items = [];
    for await (const item of paginateGraphql({
      path: "/graphql",
      query: "query Products($first: Int!, $after: String) { products(first: $first, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } }",
      variables: {},
      paginatePath: "products",
      pageSize: 2,
      version: "0.0.0-test",
    })) {
      items.push(item);
    }
    assert.deepEqual(items.map((item) => item.id), ["p1", "p2", "p3"]);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[0].body.variables.first, 2);
  } finally {
    await server.close();
    delete process.env.EXEMPLAR_API_KEY;
    delete process.env.EXEMPLAR_BASE_URL;
  }
});

test("GraphQL action help auto-lists raw variables escape hatch", () => {
  const help = showActionHelp("products", "list", {
    products: {
      list: {
        kind: "graphql",
        description: "List products.",
        flags: {
          first: { type: "string", description: "Page size" },
        },
      },
    },
  });
  assert.match(help, /--body/);
  assert.match(help, /Raw GraphQL variables JSON/);
  assert.match(help, /--first/);
});
