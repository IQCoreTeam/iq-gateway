declare module "bs58" {
  const bs58: {
    encode(input: Uint8Array): string;
    decode(input: string): Uint8Array;
  };
  export default bs58;
}
