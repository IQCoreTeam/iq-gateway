import { Buffer } from "node:buffer";

export const MAX_CODE_IN_OBJECT_BYTES = 512 * 1024;
const MAX_BASE64_BYTES = Math.ceil(MAX_CODE_IN_OBJECT_BYTES / 3) * 4;

export function decodeCodeInObject(encoded: string): Buffer {
  if (!encoded.length || encoded.length > MAX_BASE64_BYTES) throw new Error("Invalid Code-In object size");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_CODE_IN_OBJECT_BYTES || bytes.toString("base64") !== encoded) {
    throw new Error("Invalid Code-In object encoding");
  }
  return bytes;
}
