import 'dotenv/config';
import { readFileSync } from 'fs';
import { Keypair, Connection } from '@solana/web3.js';
import iqlabs from 'iqlabs-sdk';

const rpc = process.env.SOLANA_RPC_URL!;
const keypairPath = '../cli/keypair.json';
const imagePath = process.argv[2] || '/home/linbox/Git/iqlabs/iq.png';

const connection = new Connection(rpc);
const keypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))));

console.log('Wallet:', keypair.publicKey.toBase58());
console.log('Uploading:', imagePath);

iqlabs.setRpcUrl(rpc);

const imageData = readFileSync(imagePath);
const base64 = imageData.toString('base64');
const filename = imagePath.split('/').pop()!;

// Chunk it
const CHUNK_SIZE = 800;
const chunks: string[] = [];
for (let i = 0; i < base64.length; i += CHUNK_SIZE) {
  chunks.push(base64.slice(i, i + CHUNK_SIZE));
}

console.log('Size:', imageData.length, 'bytes');
console.log('Chunks:', chunks.length);

const sig = await iqlabs.writer.codeIn(
  { connection, signer: keypair },
  chunks,
  undefined,
  filename,
  0,
  'image/png',
  (p) => process.stdout.write(`\rUploading... ${p}%`)
);

console.log('\n\nDone!');
console.log('Signature:', sig);
console.log('\nTest URL:');
console.log(`http://localhost:3000/meta/${sig}.json`);
