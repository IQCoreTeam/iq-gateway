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
    version: "0.2.2",
    description:
      "Read-only HTTP cache for IQ SDK on-chain data. Same data served by any gateway instance — anyone can run their own.",
    license: { name: "See LICENSE in the iq-gateway repo" },
  },
  servers: [
    { url: "/", description: "Current gateway host" },
    { url: "https://gateway.iqlabs.dev", description: "Production (iqlabs.dev)" },
    { url: "http://localhost:3000", description: "Local dev" },
  ],
  tags: [
    { name: "tables", description: "On-chain tables — rows, metadata, notifications, live subscribe" },
    { name: "assets", description: "Inscription data — raw asset, metadata, HTML/PNG renders" },
    { name: "users", description: "Per-wallet views — assets, sessions, profile, connections, authored posts" },
    { name: "gate", description: "Token-gate verification for gated tables" },
    { name: "site", description: "Solana-hosted static sites" },
    { name: "skills", description: "AgentNet skill/workflow items: NFT JSON assembled purely from chain" },
    { name: "dbroots", description: "Cross-dApp discovery — every DbRoot the iqlabs program owns" },
    { name: "cache", description: "Disk-cache snapshot and read-only cache explorer APIs" },
    { name: "search", description: "Full-text catalog search over indexed on-chain data" },
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
          200: { description: "Rows page with `__txSignature`, `__signer`, and `__blockTime` when available. Supports If-None-Match (304) via weak ETag; head-page refresh is gated by table meta `lastTimestamp`." },
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
        summary: "Decoded table metadata (name, columns, lastTimestamp, gate)",
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
                    lastTimestamp: { type: "integer", description: "Contract-updated timestamp for the latest table row write" },
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
    "/table/{tablePda}/threads": {
      get: {
        tags: ["tables"],
        summary: "Whole comment section grouped into threads",
        description:
          "AgentNet reviews model: a comment section is ONE table, and a reply is an ordinary row carrying `meta.parentId` = id of the row it answers. Groups the flat rows server-side (2-level render cap: every descendant flattens under its top-level ancestor, keeping `parentAuthor` for an @author ref; orphan parentId → top-level) so clients render instead of each re-deriving the tree. Distinct from `/table/{feedPda}/thread/{threadPda}` above, which is the two-table + `sub` model. An unknown table is an empty section, not a 404.",
        parameters: [
          pda,
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 }, description: "Max rows scanned (newest-first)" },
        ],
        responses: {
          200: {
            description: "`{ tablePda, threads: [{ op, replies, totalReplies }], count }`",
            headers: { ETag: { schema: { type: "string" } } },
          },
          304: { description: "Not Modified" },
          400: { description: "Invalid table PDA" },
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
    "/site/{manifestSig}/manifest": {
      get: {
        tags: ["site"],
        summary: "Return the normalized site manifest as JSON",
        description: "Resolves the manifest sig, normalizes both gateway and Iqoogle formats, and returns `{ manifestSig, indexPath, files }`. Lets clients pick which files to fetch (or render the site themselves) without re-parsing raw manifest bytes.",
        parameters: [{ name: "manifestSig", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: { description: "Normalized manifest JSON" },
          400: { description: "Invalid manifest signature" },
          404: { description: "Manifest not found" },
        },
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
    "/skill/{mint}/{file}": {
      get: {
        tags: ["skills"],
        summary: "Standard NFT JSON for an AgentNet skill/workflow mint",
        description:
          "The mint uri target: marketplaces, explorers, and wallets fetch it expecting NFT JSON with an image field. Assembled purely from chain, no index or database: name/type from the Token-2022 mint account, description/traits from the code-in inscription, creator/price from the gate program's ItemConfig PDA. `{file}` is the inscription sig; a `.png` suffix 301s to the render layer's card image.",
        parameters: [
          { name: "mint", in: "path", required: true, schema: { type: "string" }, description: "Token-2022 mint (base58)" },
          { name: "file", in: "path", required: true, schema: { type: "string" }, description: "Inscription tx signature, optionally with `.png` suffix" },
        ],
        responses: {
          200: { description: "NFT metadata JSON (1h cache)", headers: { ETag: { schema: { type: "string" } } } },
          301: { description: "`.png` suffix: redirect to the render layer's card image" },
          304: { description: "Not Modified" },
          400: { description: "Malformed mint or signature" },
          404: { description: "Mint not found or carries no token metadata" },
        },
      },
    },
    "/collection/{mint}": {
      get: {
        tags: ["skills"],
        summary: "Metadata JSON for the AgentNet umbrella collection mints",
        description:
          "The two collection mints were created without a MetadataPointer extension (Token-2022 only accepts one at mint creation), so this JSON is their official face. Everything is a constant of the collection type; cached 24h.",
        parameters: [{ name: "mint", in: "path", required: true, schema: { type: "string" }, description: "Collection mint (base58); `.png` suffix tolerated" }],
        responses: {
          200: { description: "Collection metadata JSON", headers: { ETag: { schema: { type: "string" } } } },
          304: { description: "Not Modified" },
          404: { description: "Unknown collection mint" },
        },
      },
    },
    "/dbroots": {
      get: {
        tags: ["dbroots"],
        summary: "List every DbRoot owned by the iqlabs program",
        description: "Discovers DbRoot accounts on-chain via `getProgramAccounts` with a memcmp filter on the Anchor DbRoot discriminator (so the response stays small — one row per dApp). Cached 30 minutes; DbRoots only change when a new dApp launches or a table is registered, so a long TTL is fine. Returns the raw DbRoot fields, no PDA derivation: `{dbroots: [{pda, id, idHex, creator, tableCreators, extCreators, tableSeeds, globalTableSeeds}], fetchedAt, count}`. Each table-seed entry is `{label, hex, tablePda}` (label = utf-8 view or null when the hint is an already-hashed seed; hex = raw hint bytes; tablePda = the pre-derived Table PDA so a client only needs a string compare to classify an incoming pubkey).",
        responses: {
          200: { description: "DbRoot summaries" },
          500: { description: "Failed to read DbRoots from RPC" },
        },
      },
    },
    "/cache/info": {
      get: {
        tags: ["cache"],
        summary: "Cache stats — entry count, total size, by-type breakdown",
        responses: { 200: { description: "ok" } },
      },
    },
    "/cache/entries": {
      get: {
        tags: ["cache"],
        summary: "Paginated disk-cache entry index",
        description: "Read-only index for external cache explorers. Returns metadata only, not full blobs or local filesystem paths.",
        parameters: [
          { name: "type", in: "query", schema: { type: "string" }, description: "Optional cache type filter, e.g. rows, meta, img, site-file" },
          { name: "q", in: "query", schema: { type: "string", minLength: 3, maxLength: 256 }, description: "Optional indexed substring search against the cache key; requires 3-256 chars" },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Opaque cursor returned by the previous page" },
        ],
        responses: { 200: { description: "`{ entries, count, limit, nextCursor }`" }, 400: { description: "Invalid filter/cursor" }, 503: { description: "Indexed search unavailable" } },
      },
    },
    "/cache/entries/{id}": {
      get: {
        tags: ["cache"],
        summary: "Disk-cache entry detail with bounded preview",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Opaque entry id from /cache/entries" }],
        responses: {
          200: { description: "`{ entry, hasBlob, contentType, preview }`; no local filesystem path is exposed" },
          404: { description: "Entry not found" },
        },
      },
    },
    "/cache/blob/{id}": {
      get: {
        tags: ["cache"],
        summary: "Raw cached bytes for a disk-cache entry",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Opaque entry id from /cache/entries" }],
        responses: {
          200: { description: "Raw cached bytes" },
          404: { description: "Entry/blob not found" },
        },
      },
    },
    "/cache/memory": {
      get: {
        tags: ["cache"],
        summary: "Process-local memory-cache counts, keys, and optional previews",
        parameters: [
          { name: "cache", in: "query", schema: { type: "string", default: "all" }, description: "Optional cache name: meta, images, userState, sns, tableRows, tableIndex, tableSlice" },
          { name: "q", in: "query", schema: { type: "string", minLength: 3, maxLength: 256 }, description: "Optional substring search against memory cache keys; requires 3-256 chars" },
          { name: "includeValues", in: "query", schema: { type: "boolean", default: false }, description: "Include bounded value previews for one selected cache" },
          { name: "limit", in: "query", schema: { type: "integer", default: 100, maximum: 500 }, description: "Requested page size; includeValues=true is capped at 50 entries" },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "Numeric offset cursor for memory-cache pages" },
        ],
        responses: { 200: { description: "Memory-cache summary or page. Counts clear when the gateway process restarts." }, 400: { description: "Invalid cache name/filter/cursor" } },
      },
    },
    "/cache/snapshot": {
      get: {
        tags: ["cache"],
        summary: "Download a tar.gz of the entire cache",
        description: "Public. tar.gz of CACHE_DIR with a VACUUM-INTO consistent cache.db. Operators warming a cold gateway untar this into their CACHE_DIR before/while their gateway runs.",
        responses: { 200: { description: "tar.gz stream" } },
      },
    },
    "/cache/backup": {
      get: {
        tags: ["cache"],
        summary: "Metadata of the snapshot currently in BACKUP_DIR",
        description: "Read-only, no auth; lets operators inspect what a redeploy would restore. No contents, just `{ exists, path, sizeBytes, modifiedAt }`.",
        responses: { 200: { description: "Backup file metadata (`exists: false` when none)" } },
      },
      post: {
        tags: ["cache"],
        summary: "Write a cache snapshot to BACKUP_DIR/latest.tar.gz",
        description:
          "Admin-only, using the same Bearer token as /admin/*; 401 when ADMIN_TOKEN is unset (writing to the PV is not a public action). Operators curl this before `docker compose up -d --build` so the snapshot lives in the volume retained across redeploys. Atomic rename, so a crashed backup never leaves a half-written file; one backup at a time.",
        responses: {
          200: { description: "`{ path, sizeBytes, writtenAt }`" },
          401: { description: "Missing/invalid admin token" },
          409: { description: "Backup already in progress" },
          500: { description: "Snapshot setup or tar failed" },
        },
      },
    },
    "/search": {
      get: {
        tags: ["search"],
        summary: "Full-text search over the catalog index",
        description:
          "Backed by the FTS5 virtual table in cache.db; the index is populated by catalog ingest (backfill on boot + /notify hook). Query syntax is plain words only, not raw FTS5: the query is whitespace-split and every token is quoted + prefix-starred before matching, so tokens are implicitly ANDed and FTS5 operators (`AND`/`OR`/`NOT`, phrase quotes, parens) are searched as literal text: `foo OR bar` looks for the three literal words, it never unions. Tokens of 3+ chars match via the trigram index (substring semantics, BM25 rank); any token under 3 chars drops the whole query to a LIKE substring scan over the same columns, ordered by label with no rank. Never 4xxs for shape: an empty query returns `hits: []`, so a search UI can call this on every keystroke.",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" }, description: "Plain words, whitespace-split and ANDed; operators/quotes match literally; empty → no hits" },
          { name: "kind", in: "query", schema: { type: "string", enum: ["dbroot", "table", "row"] }, description: "Optional entry-kind filter; other values are ignored" },
          { name: "network", in: "query", schema: { type: "string" }, description: "Scope to one network; without it search spans every network. Unknown values just yield no hits" },
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
        responses: { 200: { description: "`{ q, hits, count }` (plus `network` when scoped)" } },
      },
    },
    "/search/stats": {
      get: {
        tags: ["search"],
        summary: "Catalog index counts",
        responses: { 200: { description: "`{ total, byKind, byNetwork }`" } },
      },
    },
    "/sns/tls-check": {
      get: {
        tags: ["site"],
        summary: "On-demand-TLS gate for *.sol.site hosts",
        description:
          "The edge (Caddy `on_demand_tls { ask ... }`) calls this before issuing a per-host Let's Encrypt cert. 200 only when `domain` is a single-label `*.sol.site` host whose `.sol` domain has a host-routing pointer record (SOL record, else TXT), the same source the proxy resolves, so the cert gate stays in lock-step with what actually serves. Anything else, including RPC failure, is 403 (fail closed) so certs never burn the LE rate limit for names that don't point at a site.",
        parameters: [{ name: "domain", in: "query", required: true, schema: { type: "string" }, description: "Full host, e.g. `name.sol.site`" }],
        responses: {
          200: { description: "Allowed: pointer record exists" },
          403: { description: "Denied: not a sol.site host, no pointer record, or lookup failed" },
        },
      },
    },
    "/sns/{domain}": {
      get: {
        tags: ["site"],
        summary: "Resolve a SNS domain to its owner + SOL record",
        description: "Returns `{domain, owner, record}`. `owner` is the registry owner wallet; `record` is the raw SOL-record value (a wallet or PDA the owner pointed the domain at, returned verbatim — the client classifies it), or null. Both cached 24h; `?fresh=1` skips the cache read. For serving a site from a domain's /site URL record, use `/sns/{domain}/record` instead.",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
          { name: "fresh", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          200: { description: "`{domain, owner, record}` (owner/record may be null)" },
        },
      },
    },
    "/sns/{domain}/pointer": {
      get: {
        tags: ["site"],
        summary: "Host-routing pointer for a SNS domain",
        description:
          "The target host-routing resolves to: the SOL record (a bare pubkey/PDA) if set, else the TXT record. CNAME and URL are deliberately not consulted. `?fresh=1` skips the cache.",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
          { name: "fresh", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          200: { description: "`{domain, pointer}` (pointer may be null)" },
          503: { description: "SNS lookup failed (RPC)" },
        },
      },
    },
    "/sns/{domain}/url": {
      get: {
        tags: ["site"],
        summary: "Raw URL record for a SNS domain, verbatim",
        description:
          "Unlike `/sns/{domain}/record` (302 into /site, sig-shaped values only), this hands the caller the unparsed URL-record string (e.g. `browser.iqlabs.dev/<pda>`) so a client like browser host-routing can interpret any URL shape itself. `?fresh=1` skips the cache.",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
          { name: "fresh", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
        ],
        responses: {
          200: { description: "`{domain, url}` (url may be null)" },
          503: { description: "SNS lookup failed (RPC)" },
        },
      },
    },
    "/sns/{domain}/record": {
      get: {
        tags: ["site"],
        summary: "Resolve a SNS domain → 302 to its IQ manifest",
        description: "Reads the TXT or Url V2 record on `<domain>.sol`. If the record value is a Solana tx signature (or wraps one inside a /site/<sig>/ URL), returns 302 to /site/<sig>/. Otherwise 404. This is the legacy site-serving redirect that `.sol.site` hosting relies on.",
        parameters: [{ name: "domain", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          302: { description: "Redirect to /site/<sig>/" },
          404: { description: "No IQ record on the domain" },
        },
      },
    },
    "/sns/{domain}/record/{path}": {
      get: {
        tags: ["site"],
        summary: "Same as /sns/{domain}/record, but redirect to a sub-path of the manifest",
        parameters: [
          { name: "domain", in: "path", required: true, schema: { type: "string" } },
          { name: "path", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          302: { description: "Redirect to /site/<sig>/<path>" },
          404: { description: "No IQ record on the domain" },
        },
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
