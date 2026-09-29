// Opt-in signed integration against a local Anvil fork; never a public RPC.
import assert from "node:assert/strict";
import { Hono } from "hono";
import { JsonRpcProvider, Wallet, NonceManager, parseEther, keccak256 } from "ethers";
import iqlabs from "@iqlabs-official/ethereum-sdk";
import { createEvmReader } from "../src/chain/evm/reader";
import { mediaRouter } from "../src/routes/media";

const rpc = process.env.IQ_EVM_LOCAL_RPC;
assert(rpc, "Set IQ_EVM_LOCAL_RPC to your local Anvil fork");
const url = new URL(rpc);
assert(url.protocol === "http:" && url.hostname === "127.0.0.1", "Only loopback HTTP is allowed");
assert(!Object.entries(process.env).some(([key, value]) => key.startsWith("ALCHEMY_") && value), "Disable Alchemy so gateway reads stay local");
const provider = new JsonRpcProvider(rpc);
const nodeInfo = await provider.send("anvil_nodeInfo", []);
assert.equal(Number((await provider.getNetwork()).chainId), 4663);
iqlabs.setNetwork("robinhood", rpc);
assert.equal(iqlabs.getRpcUrl(), rpc);
const contract = iqlabs.contract.getContractAddress();
const code = await provider.getCode(contract);
assert(code.length > 100, "Fork must include the deployed Robinhood IQ contract");
const wallet = Wallet.createRandom().connect(provider);
await provider.send("anvil_setBalance", [wallet.address, "0x" + parseEther("100").toString(16)]);
const signer = new NonceManager(wallet);
const startBlock = Number(BigInt(await provider.send("eth_blockNumber", [])));

// Original, two-second mono PCM fixture; no external media or keys.
const bytes = Buffer.alloc(44 + 32000);
bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
bytes.write("data", 36); bytes.writeUInt32LE(32000, 40);
for (let i = 0; i < 16000; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 2000), 44 + i * 2);
const body = `data:audio/wav;base64,${bytes.toString("base64")}`;
const payload = JSON.stringify({ body, type: "music", title: "Local synthetic WAV" });
const reader = createEvmReader("robinhood", rpc);
const app = new Hono<{ Variables: { chain: { kind: "evm"; network: string; readSingleRow: typeof reader.readSingleRow } } }>();
app.use("*", async (c, next) => {
  c.set("chain", { kind: "evm", network: "robinhood", readSingleRow: reader.readSingleRow });
  await next();
});
app.route("/media", mediaRouter);

const inventory = await iqlabs.writer.codeIn(signer, payload, "local-audio.json", "application/json");
assert.equal((await iqlabs.reader.readCodeIn(inventory)).data, payload);
const root = `local-media-${Date.now()}`;
await iqlabs.writer.initializeDbRoot(signer, root);
await iqlabs.writer.createTable(signer, root, "media", ["body", "type"], "type");
const inline = await iqlabs.writer.writeRow(signer, root, "media", '{"body":"small inline row","type":"text"}');
assert.equal((await reader.readSingleRow(inline))?.body, "small inline row");
const linked = await iqlabs.writer.writeRow(signer, root, "media", payload);
for (const hash of [inventory, linked]) {
  assert.equal((await reader.readSingleRow(hash))?.body, body);
  const full = await app.request(`/media/${hash}`);
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const range = await app.request(`/media/${hash}`, { headers: { Range: "bytes=0-43" } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 44));
  assert.equal((await app.request(`/media/${hash}`, { headers: { Range: `bytes=${bytes.length}-` } })).status, 416);
}
const unsafe = await iqlabs.writer.codeIn(signer, '{"body":"data:text/html;base64,PGgxPnRlc3Q8L2gxPg=="}');
assert.equal((await app.request(`/media/${unsafe}`)).status, 415);
const endBlock = Number(BigInt(await provider.send("eth_blockNumber", [])));
const receipts = [];
for (let height = startBlock + 1; height <= endBlock; height++) {
  const block = await provider.send("eth_getBlockByNumber", ["0x" + height.toString(16), false]);
  for (const hash of block.transactions) {
    const receipt = await provider.getTransactionReceipt(hash);
    assert.equal(receipt?.status, 1);
    receipts.push({ hash, block: height, status: receipt.status, gasUsed: receipt.gasUsed.toString() });
  }
}
console.log(JSON.stringify({ scope: "Local Anvil fork only; generated wallet and synthetic funds", nodeInfo,
  contract, codeHash: keccak256(code), inventory, inline, linked, mediaBytes: bytes.length,
  exactReadback: true, rangeStatus: 206, invalidRangeStatus: 416, unsafeStatus: 415, receipts }));
provider.destroy();
process.exit(0);
