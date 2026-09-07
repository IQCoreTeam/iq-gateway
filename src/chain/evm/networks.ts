// Network registry — mirrors iq-ethereum-sdk's NETWORKS but lifted here
// so the gateway can validate config without importing SDK internals.

export type NetworkMode = "sepolia" | "monad" | "monadTestnet" | "robinhood";

export interface NetworkConfig {
  chainId: number;
  defaultRpc: string;
  contractAddress: string;
  currency: string;
  explorer: string;
}

export const NETWORKS: Record<NetworkMode, NetworkConfig> = {
  sepolia: {
    chainId: 11155111,
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    contractAddress: "0x246A08D9fdD9b3990A88eD1f2DF1A87239839F07",
    currency: "ETH",
    explorer: "https://sepolia.etherscan.io",
  },
  monad: {
    chainId: 143,
    defaultRpc: "https://rpc.monad.xyz",
    contractAddress: "0x7ae06f87Cf93606DA2BD6A281afB28028cAE233D",
    currency: "MON",
    explorer: "https://monadvision.com",
  },
  monadTestnet: {
    chainId: 10143,
    defaultRpc: "https://testnet-rpc.monad.xyz",
    contractAddress: "0x3379883538C068978e199472b5D127055c734867",
    currency: "MON",
    explorer: "https://testnet.monadexplorer.com",
  },
  // Robinhood Chain mainnet (Arbitrum-stack L2, ETH gas). No testnet contract
  // is deployed yet; rehearse on monadTestnet/sepolia instead.
  robinhood: {
    chainId: 4663,
    defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
    contractAddress: "0x88af59e58C7E5DcbE7cc12972B90cff3fEEF7223",
    currency: "ETH",
    explorer: "https://robinhoodchain.blockscout.com",
  },
};

export function isNetworkMode(s: string | undefined): s is NetworkMode {
  return !!s && s in NETWORKS;
}
