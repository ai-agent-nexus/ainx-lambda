import { verify as cryptoVerify, KeyObject } from 'crypto';

export function verifySignature(
  publicKey: Buffer | KeyObject,
  message: string,
  signature: Buffer
): boolean {
  if (!publicKey) {
    throw new Error('Public key must be provided');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('Message must be a non-empty string');
  }
  if (!signature || !Buffer.isBuffer(signature)) {
    throw new Error('Signature must be a Buffer');
  }

  try {
    return cryptoVerify(null, Buffer.from(message), publicKey, signature);
  } catch {
    return false;
  }
}
