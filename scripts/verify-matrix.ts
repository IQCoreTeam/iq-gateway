// Live multi-chain verification harness.
//
// Boots nothing itself — point it at an already-running MULTI gateway
// (IQ_CHAIN unset) that has Solana + EVM RPCs configured:
//
//   SOLANA_RPC_ENDPOINT=... IQETH_RPC_SEPOLIA=... bun run src/server.ts &
//   BASE=http://localhost:3000 bun run scripts/verify-matrix.ts
//
// Verifies the route × network matrix plus the resolver/plumbing checks the
// single-runner model risks (cache isolation, concurrency, clean 4xx,
// capability gating). Exits non-zero on any failure.

const BASE = process.env.BASE || "http://localhost:3000";

// A known Sepolia fixture (from e2e-setup). Other networks are checked for
// correct status/shape rather than specific data.
const EVM_TX = "0xfcfcccca3f55ad2c1b02c23f233d42df01b667de6c8d85caefe0573d17c3d483";
const EVM_ADDR = "0x76ce2c5F3C50e9074C4342BE37d7a90CAC30829c";
const EVM_ROOT = "iq-eth-gateway-test-navv17";
const SOL_PUBKEY = "11111111111111111111111111111111";

let pass = 0;
let fail = 0;
const failures: string[] = [];

async function check(desc: string, url: string, expect: (status: number, body: string) => boolean) {
  try {
    const res = await fetch(BASE + url, { signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (expect(res.status, body)) {
      console.log(`  ✅ ${desc} [${res.status}]`);
      pass++;
    } else {
      console.log(`  ❌ ${desc} [${res.status}] ${body.slice(0, 100)}`);
      failures.push(desc);
      fail++;
    }
  } catch (e) {
    console.log(`  ❌ ${desc} [ERR] ${e instanceof Error ? e.message : e}`);
    failures.push(desc);
    fail++;
  }
}

const ok = (s: number) => s === 200;
const is = (...codes: number[]) => (s: number) => codes.includes(s);

console.log(`\n=== route × network matrix @ ${BASE} ===`);

console.log("\n[health/system]");
await check("GET /health (multi)", "/health", (s, b) => ok(s) && b.includes("multi"));
await check("GET /version", "/version", (s, b) => ok(s) && b.includes("version"));
await check("GET /docs", "/docs", ok);
await check("GET /openapi.json", "/openapi.json", (s, b) => ok(s) && b.includes("openapi"));

console.log("\n[EVM — sepolia (default, 0x auto-detect)]");
await check("GET /data/{tx}", `/data/${EVM_TX}`, (s, b) => ok(s) && b.includes("author"));
await check("GET /meta/{tx}.json", `/meta/${EVM_TX}.json`, (s, b) => ok(s) && b.includes("name"));
await check("GET /img/{tx}.png", `/img/${EVM_TX}.png`, ok);
await check("GET /view/{tx}", `/view/${EVM_TX}`, ok);
await check("GET /render/{tx}", `/render/${EVM_TX}`, ok);
await check("GET /table/{root}/posts/rows", `/table/${EVM_ROOT}/posts/rows`, (s, b) => ok(s) && b.includes("rows"));
await check("GET /table/{root}/posts/meta", `/table/${EVM_ROOT}/posts/meta`, is(200, 404));
await check("GET /user/{addr}/assets", `/user/${EVM_ADDR}/assets`, ok);
await check("GET /user/{addr}/state", `/user/${EVM_ADDR}/state`, ok);
await check("GET /gate/{root}/posts/check/{wallet}", `/gate/${EVM_ROOT}/posts/check/${EVM_ADDR}`, (s, b) => ok(s) && b.includes("meetsGate"));
await check("GET /dbroots?network=sepolia", "/dbroots?network=sepolia", (s, b) => ok(s) && b.includes("dbroots"));

console.log("\n[search — global vs network-scoped]");
// Search never 4xxs on shape; with ?network it scopes + echoes the network,
// without it spans all networks (global catalog).
await check("GET /search?q=iq (global)", "/search?q=iq", (s, b) => s === 200 && b.includes("hits"));
await check("GET /search?q=iq&network=sepolia (scoped echoes network)", "/search?q=iq&network=sepolia", (s, b) => s === 200 && b.includes('"network":"sepolia"'));
await check("GET /search?q=iq&network=bogus (no 4xx, just no scope match)", "/search?q=iq&network=bogus", (s) => s === 200);

console.log("\n[EVM — monad / monadTestnet via ?network]");
await check("GET /table rows ?network=monad", `/table/${EVM_ROOT}/posts/rows?network=monad`, is(200, 404, 500));
await check("GET /data ?network=monadTestnet", `/data/${EVM_TX}?network=monadTestnet`, is(200, 404));

console.log("\n[Solana — base58 auto-detect]");
await check("GET /user/{pubkey}/state (base58)", `/user/${SOL_PUBKEY}/state`, is(200, 404, 500));
await check("GET /sns/{domain} (→solana prefix)", "/sns/example", is(200, 302, 404, 503));

console.log("\n[capability gating + resolver errors]");
await check("GET /ens/vitalik.eth (→evm prefix)", "/ens/vitalik.eth", (s, b) => ok(s) && b.includes("address"));
await check("unknown ?network=foo → 400", `/data/${EVM_TX}?network=foo`, is(400));
await check("?network=solana on a 0x id → solana (404/500, not wrong-chain 200)", `/data/${EVM_TX}?network=solana`, is(400, 404, 500));

console.log("\n[cache isolation — same tx, two networks, independent entries]");
// Hit sepolia then monadTestnet for the same tx hash; both must resolve on their
// own merits (sepolia has data → 200; the other 200/404) and never cross-serve.
await check("isolation: /data sepolia", `/data/${EVM_TX}?network=sepolia`, (s, b) => ok(s) && b.includes("author"));
await check("isolation: /data monadTestnet (independent)", `/data/${EVM_TX}?network=monadTestnet`, is(200, 404));

console.log("\n[concurrency — parallel different-network requests]");
{
  const results = await Promise.all([
    fetch(`${BASE}/data/${EVM_TX}?network=sepolia`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0),
    fetch(`${BASE}/data/${EVM_TX}?network=monadTestnet`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0),
    fetch(`${BASE}/table/${EVM_ROOT}/posts/rows?network=sepolia`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0),
    fetch(`${BASE}/ens/vitalik.eth`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0),
  ]);
  const noServerError = results.every((s) => s !== 0 && s < 500);
  if (noServerError) { console.log(`  ✅ parallel multi-network requests ok [${results.join(",")}]`); pass++; }
  else { console.log(`  ❌ parallel requests had errors [${results.join(",")}]`); failures.push("concurrency"); fail++; }
}

console.log(`\n═══════════════════════════════`);
console.log(`Result: ${pass} pass, ${fail} fail / ${pass + fail}`);
if (fail > 0) {
  console.log(`Failures: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All multi-chain matrix checks passed.");
