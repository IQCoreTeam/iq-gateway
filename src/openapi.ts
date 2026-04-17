/**
 * OpenAPI 3.0 spec for the IQ Gateway. Served from GET /openapi.json and
 * rendered by the Swagger UI page at GET /docs. Hand-maintained; keep in
 * sync when adding or changing endpoints.
 */

const pda = { name: "tablePda", in: "path", required: true, schema: { type: "string" }, description: "On-chain table PDA (base58)" };
const sig = { name: "sig", in: "path", required: true, schema: { type: "string" }, description: "Transaction signature (base58)" };
const pubkey = { name: "pubkey", in: "path", required: true, schema: { type: "string" }, description: "Wallet pubkey (base58)" };

export const openapiSpec = {
  openapi: "3.0.3",
  info: {
    title: "IQ Gateway",
    version: "0.1.0",
    description:
      "Read-only HTTP cache for IQ SDK on-chain data. Same data served by any gateway instance — anyone can run their own.",
    license: { name: "See LICENSE in the iq-gateway repo" },
  },
  servers: [
    { url: "https://gateway.solanainternet.com", description: "Production" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "tables", description: "On-chain tables — rows, metadata, notifications, live subscribe" },
    { name: "assets", description: "Inscription data — raw asset, metadata, HTML/PNG renders" },
    { name: "users", description: "Per-wallet views — assets, sessions, profile, connections, authored posts" },
    { name: "gate", description: "Token-gate verification for gated tables" },
    { name: "site", description: "Solana-hosted static sites" },
    { name: "system", description: "Health checks, cache stats, version" },
  ],
  paths: {
    "/table/{tablePda}/rows": {
      get: {
        tags: ["tables"],
        summary: "Paginated rows for a table PDA",
        parameters: [
          pda,
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 50 } },
          { name: "before", in: "query", schema: { type: "string" }, description: "Cursor — last sig of previous page" },
          { name: "fresh", in: "query", schema: { type: "boolean" }, description: "Bypass memory/disk cache" },
        ],
        responses: {
          200: { description: "Rows page. Supports If-None-Match (304) via weak ETag." },
          304: { description: "Not Modified — ETag matched" },
          400: { description: "Invalid PDA" },
          404: { description: "Table not found" },
        },
      },
    },
    "/table/{tablePda}/index": {
      get: {
        tags: ["tables"],
        summary: "Full signature index for a table (up to 10000 sigs)",
        parameters: [pda],
        responses: { 200: { description: "Signature list" }, 404: { description: "Table not found" } },
      },
    },
    "/table/{tablePda}/slice": {
      get: {
        tags: ["tables"],
        summary: "Fetch specific rows by signature (max 50)",
        parameters: [pda, { name: "sigs", in: "query", required: true, schema: { type: "string" }, description: "Comma-separated signatures" }],
        responses: { 200: { description: "Slice of rows" } },
      },
    },
    "/table/{tablePda}/meta": {
      get: {
        tags: ["tables"],
        summary: "Decoded table metadata (name, columns, gate)",
        parameters: [pda],
        responses: {
          200: {
            description: "Meta",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    columns: { type: "array", items: { type: "string" } },
                    idCol: { type: "string" },
                    gate: {
                      nullable: true,
                      type: "object",
                      properties: {
                        mint: { type: "string" },
                        amount: { type: "integer" },
                        gateType: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          404: { description: "Table account not found" },
        },
      },
    },
    "/table/{tablePda}/notify": {
      post: {
        tags: ["tables"],
        summary: "Warm cache + push SSE for a new tx",
        description:
          "Frontend calls this after writing a row on chain. The row is injected into cached pages for instant visibility and pushed to any SSE subscribers for the PDA. `signer` at top level stamps `__signer` onto the row.",
        parameters: [pda],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["txSignature"],
                properties: {
                  txSignature: { type: "string" },
                  row: { type: "object", additionalProperties: true },
                  signer: { type: "string", description: "Fee payer pubkey — used for __signer stamp + user-asset invalidation" },
                },
              },
            },
          },
        },
        responses: { 200: { description: "`{ ok: true, cached: boolean }`" }, 400: { description: "Missing/invalid body" } },
      },
    },
    "/table/{tablePda}/subscribe": {
      get: {
        tags: ["tables"],
        summary: "Server-Sent Events stream of new rows for this PDA",
        description:
          "Opens a persistent SSE connection. Emits `event: hello` on connect, `event: row` for each row injected via /notify, and `event: ping` every 30s as a keepalive.",
        parameters: [pda],
        responses: {
          200: {
            description: "SSE stream (`text/event-stream`)",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          400: { description: "Invalid PDA" },
        },
      },
    },
    "/table/{feedPda}/thread/{threadPda}": {
      get: {
        tags: ["tables"],
        summary: "Resolved thread — OP + replies in one call",
        description:
          "Runs the server-side OP picker (prefer rows with non-empty `sub`, tiebreak by earliest time). Saves the client two `/rows` calls plus the OP-detection logic.",
        parameters: [
          { name: "feedPda", in: "path", required: true, schema: { type: "string" }, description: "Feed PDA (board's feed table)" },
          { name: "threadPda", in: "path", required: true, schema: { type: "string" }, description: "Thread's own table PDA" },
          { name: "replyLimit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "feedScan", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
        ],
        responses: {
          200: {
            description: "`{ op, replies, totalReplies, feedPda, threadPda }`",
            headers: { ETag: { schema: { type: "string" } } },
          },
          304: { description: "Not Modified" },
        },
      },
    },
    "/table/dbroot": {
      get: {
        tags: ["tables"],
        summary: "DbRoot info — table seeds, creators, names",
        responses: { 200: { description: "DbRoot state" } },
      },
    },
    "/table/cache/stats": {
      get: {
        tags: ["system"],
        summary: "Per-cache entry counts and TTLs",
        responses: { 200: { description: "Cache stats" } },
      },
    },
    "/data/{sig}": {
      get: {
        tags: ["assets"],
        summary: "Raw asset data + metadata for an inscription tx",
        parameters: [sig],
        responses: { 200: { description: "`{ data, metadata, signature, signer, blockTime, slot }`" } },
      },
    },
    "/meta/{sig}.json": {
      get: {
        tags: ["assets"],
        summary: "Metaplex-compatible NFT metadata",
        parameters: [{ ...sig, name: "sig" }],
        responses: { 200: { description: "Metaplex JSON" } },
      },
    },
    "/img/{sig}.png": {
      get: {
        tags: ["assets"],
        summary: "Raw image bytes for an inscription",
        parameters: [{ ...sig, name: "sig" }],
        responses: { 200: { description: "Image bytes", content: { "image/*": { schema: { type: "string", format: "binary" } } } } },
      },
    },
    "/view/{sig}": {
      get: {
        tags: ["assets"],
        summary: "HTML render of a text inscription",
        parameters: [sig],
        responses: { 200: { description: "HTML", content: { "text/html": { schema: { type: "string" } } } } },
      },
    },
    "/render/{sig}": {
      get: {
        tags: ["assets"],
        summary: "PNG/SVG render of a text inscription",
        parameters: [sig],
        responses: { 200: { description: "PNG or SVG" } },
      },
    },
    "/user/{pubkey}/assets": {
      get: {
        tags: ["users"],
        summary: "Assets uploaded by this wallet",
        parameters: [
          pubkey,
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 100 } },
          { name: "before", in: "query", schema: { type: "string" } },
        ],
        responses: { 200: { description: "Asset list" } },
      },
    },
    "/user/{pubkey}/sessions": {
      get: { tags: ["users"], summary: "Session accounts", parameters: [pubkey], responses: { 200: { description: "Sessions" } } },
    },
    "/user/{pubkey}/profile": {
      get: { tags: ["users"], summary: "Parsed profile JSON", parameters: [pubkey], responses: { 200: { description: "Profile" } } },
    },
    "/user/{pubkey}/state": {
      get: { tags: ["users"], summary: "Raw on-chain user state", parameters: [pubkey], responses: { 200: { description: "State" } } },
    },
    "/user/{pubkey}/connections": {
      get: { tags: ["users"], summary: "User connections", parameters: [pubkey], responses: { 200: { description: "Connections" } } },
    },
    "/user/{pubkey}/posts": {
      get: {
        tags: ["users"],
        summary: "Sigs this wallet has authored (opportunistic index)",
        description:
          "Built at decode time — a wallet's full history shows up only as the gateway processes rows. Clients should treat the result as 'known so far', not exhaustive.",
        parameters: [pubkey, { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } }],
        responses: {
          200: {
            description: "`{ pubkey, signatures, count, note }`",
          },
        },
      },
    },
    "/gate/{tablePda}/check/{wallet}": {
      get: {
        tags: ["gate"],
        summary: "Check if a wallet meets a table's gate config",
        description:
          "Returns SOL balance, token balance for the gate mint (if any), and `meetsGate` (true if ungated OR both SOL and token thresholds met). Cached 30s per wallet.",
        parameters: [
          pda,
          { name: "wallet", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          200: {
            description: "Gate verdict",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    tablePda: { type: "string" },
                    wallet: { type: "string" },
                    sol: { type: "number" },
                    gate: {
                      nullable: true,
                      type: "object",
                      properties: {
                        mint: { type: "string" },
                        amount: { type: "integer" },
                        gateType: { type: "integer" },
                      },
                    },
                    tokenBalance: { type: "number" },
                    meetsGate: { type: "boolean" },
                    minSol: { type: "number" },
                  },
                },
              },
            },
          },
          404: { description: "Table not found" },
        },
      },
    },
    "/site/{manifestSig}": {
      get: {
        tags: ["site"],
        summary: "Serve index.html of a Solana-hosted site",
        parameters: [{ name: "manifestSig", in: "path", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "Site HTML" } },
      },
    },
    "/site/{manifestSig}/{path}": {
      get: {
        tags: ["site"],
        summary: "Serve any file from a site manifest",
        parameters: [
          { name: "manifestSig", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { 200: { description: "File content" } },
      },
    },
    "/health": {
      get: { tags: ["system"], summary: "Health + cache + RPC metrics", responses: { 200: { description: "ok" } } },
    },
    "/version": {
      get: { tags: ["system"], summary: "Gateway version", responses: { 200: { description: "`{ version }`" } } },
    },
  },
} as const;
