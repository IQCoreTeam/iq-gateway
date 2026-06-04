/**
 * OpenAPI 3.0 spec for the IQ Eth Gateway. Served from GET /openapi.json and
 * rendered by Swagger UI at /docs.
 */

const dbRootId = { name: "dbRootId", in: "path", required: true, schema: { type: "string" }, description: "Human-readable database root id" };
const tableName = { name: "tableName", in: "path", required: true, schema: { type: "string" }, description: "Table name (within the dbRoot)" };
const txHash = { name: "txHash", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, description: "EVM transaction hash" };
const address = { name: "address", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, description: "EVM wallet address" };

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "IQ Eth Gateway",
    version: "0.2.2",
    description: "Read-only HTTP cache for IQ Labs on-chain data on EVM chains (Sepolia, Monad, Monad Testnet).",
    license: { name: "Apache-2.0" },
  },
  servers: [
    { url: "/", description: "Current gateway host" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "tables", description: "On-chain tables — rows, metadata, notifications, live subscribe" },
    { name: "assets", description: "Inscription data — raw asset, metadata, HTML/PNG renders" },
    { name: "users", description: "Per-wallet views" },
    { name: "gate", description: "Token-gate verification" },
    { name: "ens", description: "ENS resolver" },
    { name: "dbroots", description: "Cross-dApp discovery" },
    { name: "cache", description: "Disk-cache snapshot and explorer APIs" },
    { name: "system", description: "Health, version" },
  ],
  paths: {
    "/table/{dbRootId}/{tableName}/rows": {
      get: {
        tags: ["tables"],
        summary: "Paginated rows for a table",
        parameters: [
          dbRootId, tableName,
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 50 } },
          { name: "before", in: "query", schema: { type: "string" }, description: "Cursor — last txHash of previous page" },
          { name: "fresh", in: "query", schema: { type: "boolean" }, description: "Bypass cache" },
        ],
        responses: {
          200: { description: "Rows page. ETag/304 supported." },
          304: { description: "Not Modified" },
          404: { description: "Table not found" },
        },
      },
    },
    "/table/{dbRootId}/{tableName}/index": {
      get: { tags: ["tables"], summary: "Full tx-hash index (up to 10000)", parameters: [dbRootId, tableName], responses: { 200: { description: "Hash list" }, 404: { description: "Not found" } } },
    },
    "/table/{dbRootId}/{tableName}/slice": {
      get: {
        tags: ["tables"],
        summary: "Fetch rows by tx hash (max 50)",
        parameters: [dbRootId, tableName, { name: "sigs", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated tx hashes" }],
        responses: { 200: { description: "Slice of rows" } },
      },
    },
    "/table/{dbRootId}/{tableName}/meta": {
      get: { tags: ["tables"], summary: "Decoded table metadata", parameters: [dbRootId, tableName], responses: { 200: { description: "Meta" }, 404: { description: "Not found" } } },
    },
    "/table/{dbRootId}/{tableName}/notify": {
      post: {
        tags: ["tables"],
        summary: "Warm cache + push SSE for a new tx",
        parameters: [dbRootId, tableName],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["txHash"],
                properties: {
                  txHash: { type: "string" },
                  row: { type: "object", additionalProperties: true },
                  signer: { type: "string", description: "fee payer address — stamps __signer + invalidates user asset cache" },
                },
              },
            },
          },
        },
        responses: { 200: { description: "{ ok, cached }" }, 400: { description: "Missing/invalid body" } },
      },
    },
    "/table/{dbRootId}/{tableName}/subscribe": {
      get: {
        tags: ["tables"],
        summary: "SSE stream of new rows",
        parameters: [dbRootId, tableName],
        responses: { 200: { description: "SSE", content: { "text/event-stream": { schema: { type: "string" } } } } },
      },
    },
    "/table/{dbRootId}/{feedName}/thread/{threadName}": {
      get: {
        tags: ["tables"],
        summary: "Resolved thread — OP + replies",
        parameters: [
          dbRootId,
          { name: "feedName", in: "path", required: true, schema: { type: "string" } },
          { name: "threadName", in: "path", required: true, schema: { type: "string" } },
          { name: "replyLimit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "feedScan", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
        ],
        responses: { 200: { description: "{ op, replies, totalReplies }" } },
      },
    },
    "/table/dbroot": {
      get: {
        tags: ["tables"],
        summary: "Inspect a single dbRoot",
        parameters: [{ name: "id", in: "query", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "DbRoot state" } },
      },
    },
    "/table/cache/stats": { get: { tags: ["system"], summary: "Per-cache entry counts and TTLs", responses: { 200: { description: "ok" } } } },

    "/data/{txHash}": { get: { tags: ["assets"], summary: "Raw asset data + metadata", parameters: [txHash], responses: { 200: { description: "ok" } } } },
    "/meta/{txHash}.json": { get: { tags: ["assets"], summary: "Metaplex-compatible NFT metadata", parameters: [{ ...txHash, name: "txHash" }], responses: { 200: { description: "Metaplex JSON" } } } },
    "/img/{txHash}.png": { get: { tags: ["assets"], summary: "Raw image bytes", parameters: [{ ...txHash, name: "txHash" }], responses: { 200: { description: "Image bytes", content: { "image/*": { schema: { type: "string", format: "binary" } } } } } } },
    "/view/{txHash}": { get: { tags: ["assets"], summary: "HTML render of a text inscription", parameters: [txHash], responses: { 200: { description: "HTML" } } } },
    "/render/{txHash}": { get: { tags: ["assets"], summary: "PNG/SVG render", parameters: [txHash], responses: { 200: { description: "PNG or SVG" } } } },

    "/user/{address}/assets": {
      get: {
        tags: ["users"],
        summary: "Assets uploaded by this wallet",
        parameters: [
          address,
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "before", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: { description: "Asset list" } },
      },
    },
    "/user/{address}/profile": { get: { tags: ["users"], summary: "Parsed profile JSON", parameters: [address], responses: { 200: { description: "Profile" } } } },
    "/user/{address}/state": { get: { tags: ["users"], summary: "Raw on-chain user state", parameters: [address], responses: { 200: { description: "State" } } } },
    "/user/{address}/connections": { get: { tags: ["users"], summary: "User connections", parameters: [address], responses: { 200: { description: "Connections" } } } },
    "/user/{address}/posts": { get: { tags: ["users"], summary: "Tx hashes authored by wallet (opportunistic)", parameters: [address, { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } }], responses: { 200: { description: "{ address, txHashes, count, note }" } } } },

    "/gate/{dbRootId}/{tableName}/check/{wallet}": {
      get: {
        tags: ["gate"],
        summary: "Token/NFT gate check for a wallet",
        parameters: [
          dbRootId, tableName,
          { name: "wallet", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "Gate verdict" }, 404: { description: "Table not found" } },
      },
    },

    "/ens/{name}": {
      get: {
        tags: ["ens"],
        summary: "Resolve an ENS name or reverse-resolve an address",
        parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ name, address } or { address, name }" } },
      },
    },
    "/ens/{addr}/reverse": {
      get: {
        tags: ["ens"],
        summary: "Reverse-resolve an address to an ENS name",
        parameters: [{ name: "addr", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "{ address, name }" } },
      },
    },

    "/dbroots": { get: { tags: ["dbroots"], summary: "List known dbRoots + their tables", responses: { 200: { description: "DbRoot summaries" } } } },

    "/cache/info": { get: { tags: ["cache"], summary: "Cache stats", responses: { 200: { description: "ok" } } } },
    "/cache/entries": {
      get: {
        tags: ["cache"],
        summary: "Paginated disk-cache entry index",
        parameters: [
          { name: "type", in: "query", schema: { type: "string" } },
          { name: "q", in: "query", schema: { type: "string", minLength: 3, maxLength: 256 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: { description: "{ entries, count, limit, nextCursor }" }, 400: { description: "Invalid filter/cursor" }, 503: { description: "Search unavailable" } },
      },
    },
    "/cache/entries/{id}": { get: { tags: ["cache"], summary: "Entry detail with preview", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" }, 404: { description: "Not found" } } } },
    "/cache/blob/{id}": { get: { tags: ["cache"], summary: "Raw cached bytes", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" }, 404: { description: "Not found" } } } },
    "/cache/memory": {
      get: {
        tags: ["cache"],
        summary: "Memory-cache counts/previews",
        parameters: [
          { name: "cache", in: "query", schema: { type: "string", default: "all" } },
          { name: "q", in: "query", schema: { type: "string", minLength: 3, maxLength: 256 } },
          { name: "includeValues", in: "query", schema: { type: "boolean", default: false } },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: { description: "ok" }, 400: { description: "Invalid filter/cursor" } },
      },
    },
    "/cache/snapshot": { get: { tags: ["cache"], summary: "Streamed tar.gz of full cache", responses: { 200: { description: "tar.gz stream" } } } },

    "/health": { get: { tags: ["system"], summary: "Health + cache + RPC metrics", responses: { 200: { description: "ok" } } } },
    "/version": { get: { tags: ["system"], summary: "Gateway version", responses: { 200: { description: "{ version }" } } } },
  },
} as const;
