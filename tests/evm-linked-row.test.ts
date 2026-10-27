import { afterEach, expect, spyOn, test } from "bun:test";
import { Interface, JsonRpcProvider } from "ethers";
import iqlabs from "@iqlabs-official/ethereum-sdk";
import { createEvmReader } from "../src/chain/evm/reader";
import "./helpers/cache-fixture";

const abi = new Interface(iqlabs.contract.CODEIN_ABI);
const hash = "0x" + "ab".repeat(32);
const root = "0x" + "cd".repeat(32);
const reader = createEvmReader("robinhood", "http://127.0.0.1:1");
const restore: Array<() => void> = [];
afterEach(() => { for (const undo of restore.splice(0).reverse()) undo(); });

for (const method of ["dbCodeIn", "dbInstructionCodeIn", "walletConnectionCodeIn"]) {
  test(`${method} reconstructs linked rows using the SDK`, async () => {
    const fragment = abi.getFunction(method)!;
    const args = fragment.inputs.map(input => input.type === "bytes32" ? root : input.type === "address" ? "0x" + "12".repeat(20) : "");
    args[2] = hash;
    args[3] = '{"total_chunks":2}';
    const transaction = spyOn(JsonRpcProvider.prototype, "getTransaction").mockResolvedValue({
      data: abi.encodeFunctionData(method, args), from: "0x" + "12".repeat(20), blockNumber: null,
    } as never);
    const inventory = spyOn(iqlabs.reader, "readCodeIn").mockRejectedValue(new Error(`Unexpected function: ${method}`));
    const chunks = spyOn(iqlabs.reader, "readSendCodeChain").mockResolvedValue('{"body":"reconstructed media","type":"audio"}');
    restore.push(() => transaction.mockRestore(), () => inventory.mockRestore(), () => chunks.mockRestore());
    const row = await reader.readSingleRow(hash);
    expect(row?.body).toBe("reconstructed media");
    expect(row?.__txHash).toBe(hash);
    expect(chunks).toHaveBeenCalledWith(hash);
    chunks.mockRejectedValueOnce(new Error("missing chunk history"));
    await expect(reader.readSingleRow(hash)).rejects.toThrow("missing chunk history");
  });
}
