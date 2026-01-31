import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { readFileSync } from "fs";

import IDL from "../../idl/iq_gateway_registry.json";

const PROGRAM_ID = new PublicKey("4H44PbCzjoJjbg6NyYbueu4s3Q6er1fAL4iNL3atW29w");

export interface GatewayInfo {
  url: string;
  owner: string;
  pda: string;
  registeredAt: number;
  lastHeartbeat: number;
  active: boolean;
}

export class RegistryClient {
  private connection: Connection;
  private program: Program;
  private wallet: Keypair | null = null;
  private selfUrl: string;

  constructor(rpcUrl: string, selfUrl: string, keypairPath?: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    this.selfUrl = selfUrl;

    if (keypairPath) {
      try {
        const secretKey = JSON.parse(readFileSync(keypairPath, "utf8"));
        this.wallet = Keypair.fromSecretKey(new Uint8Array(secretKey));
      } catch {
        console.warn("Registry: No wallet configured, running in read-only mode");
      }
    }

    const provider = new anchor.AnchorProvider(
      this.connection,
      this.wallet ? new anchor.Wallet(this.wallet) : (null as any),
      { commitment: "confirmed" }
    );

    this.program = new Program(IDL, provider);
  }

  private getRegistryPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("registry")], PROGRAM_ID);
    return pda;
  }

  private getGatewayPda(owner: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("gateway"), owner.toBuffer()],
      PROGRAM_ID
    );
    return pda;
  }

  async fetchGateways(): Promise<GatewayInfo[]> {
    try {
      const accounts = await this.program.account.gateway.all();
      const now = Date.now() / 1000;

      return accounts.map(({ publicKey, account }) => ({
        url: account.url as string,
        owner: (account.owner as PublicKey).toString(),
        pda: publicKey.toString(),
        registeredAt: (account.registeredAt as anchor.BN).toNumber(),
        lastHeartbeat: (account.lastHeartbeat as anchor.BN).toNumber(),
        active: now - (account.lastHeartbeat as anchor.BN).toNumber() < 300,
      }));
    } catch (e) {
      console.error("Registry: Failed to fetch gateways:", e);
      return [];
    }
  }

  async fetchPeers(): Promise<string[]> {
    const gateways = await this.fetchGateways();
    return gateways
      .filter((g) => g.active && g.url !== this.selfUrl)
      .map((g) => g.url);
  }

  async register(): Promise<string | null> {
    if (!this.wallet) {
      console.warn("Registry: Cannot register without wallet");
      return null;
    }

    const gatewayPda = this.getGatewayPda(this.wallet.publicKey);
    const existing = await this.connection.getAccountInfo(gatewayPda);

    if (existing) {
      console.log("Registry: Already registered, sending heartbeat");
      return this.heartbeat();
    }

    try {
      const tx = await this.program.methods
        .registerGateway(this.selfUrl)
        .accounts({
          registry: this.getRegistryPda(),
          gateway: gatewayPda,
          owner: this.wallet.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();

      console.log("Registry: Registered gateway, tx:", tx);
      return tx;
    } catch (e) {
      console.error("Registry: Failed to register:", e);
      return null;
    }
  }

  async heartbeat(): Promise<string | null> {
    if (!this.wallet) return null;

    try {
      const tx = await this.program.methods
        .heartbeat()
        .accounts({
          gateway: this.getGatewayPda(this.wallet.publicKey),
          owner: this.wallet.publicKey,
        })
        .signers([this.wallet])
        .rpc();

      return tx;
    } catch (e) {
      console.error("Registry: Heartbeat failed:", e);
      return null;
    }
  }

  async deregister(): Promise<string | null> {
    if (!this.wallet) return null;

    try {
      const tx = await this.program.methods
        .deregister()
        .accounts({
          registry: this.getRegistryPda(),
          gateway: this.getGatewayPda(this.wallet.publicKey),
          owner: this.wallet.publicKey,
        })
        .signers([this.wallet])
        .rpc();

      console.log("Registry: Deregistered, tx:", tx);
      return tx;
    } catch (e) {
      console.error("Registry: Failed to deregister:", e);
      return null;
    }
  }
}
