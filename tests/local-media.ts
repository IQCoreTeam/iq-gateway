// Opt-in real SDK reconstruction on offline Surfpool, not a full gateway boot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hono } from "hono";

assert.equal(process.env.SOLANA_RPC_ENDPOINT, "http://127.0.0.1:19109");
assert.ok(process.env.IQ_MEDIA_REPORT, "Pass the local-inscribe JSON receipt report");
assert.ok(!process.env.HELIUS_API_KEY && !process.env.HELIUS_API_KEYS);
const {mediaSignature, mediaBytes} = JSON.parse(readFileSync(process.env.IQ_MEDIA_REPORT, "utf8"));
const { Connection } = await import("@solana/web3.js");
assert.notEqual(await new Connection(process.env.SOLANA_RPC_ENDPOINT).getGenesisHash(), "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
const { readSingleRow } = await import("../src/chain/solana/reader");
const { mediaRouter } = await import("../src/routes/media");
const app = new Hono<{Variables:{chain:{kind:"solana";network:string;readSingleRow:typeof readSingleRow}}}>();
app.use("*", async (c,next) => {c.set("chain",{kind:"solana",network:"solana",readSingleRow}); await next();});
app.route("/media",mediaRouter);
const full = await app.request(`/media/${mediaSignature}`);
assert.equal(full.status,200);
assert.equal(full.headers.get("content-type"),"audio/wav");
const bytes = Buffer.from(await full.arrayBuffer());
assert.equal(bytes.length,mediaBytes);
assert.equal(bytes.subarray(0,4).toString(),"RIFF");
const part = await app.request(`/media/${mediaSignature}`,{headers:{Range:"bytes=0-43"}});
assert.equal(part.status,206);
assert.deepEqual(Buffer.from(await part.arrayBuffer()),bytes.subarray(0,44));
console.log(JSON.stringify({scope:"offline Surfpool; actual gateway row reader",signature:mediaSignature,bytes:bytes.length,mime:full.headers.get("content-type"),rangeStatus:part.status}));
