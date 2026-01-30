# Scripts

## upload-test.ts
Upload a file to Solana.
```bash
bun run scripts/upload-test.ts <file-path>
```

## mint-token.ts
Create a new fungible token with on-chain image.
```bash
ASSET_SIG="<tx-sig-from-upload>" bun run scripts/mint-token.ts
```

## mint-nft.ts
Create an NFT with on-chain image.
```bash
ASSET_SIG="<tx-sig-from-upload>" bun run scripts/mint-nft.ts
```

## mint-supply.ts
Mint additional supply to an existing token.
```bash
MINT_ADDRESS="<token-mint-address>" MINT_AMOUNT="<raw-amount>" bun run scripts/mint-supply.ts
```
Note: MINT_AMOUNT is raw (with decimals). For 1M tokens with 9 decimals: `1000000000000000`
