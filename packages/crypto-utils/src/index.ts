import { verify as cryptoVerify, KeyObject, createPublicKey } from 'crypto';

// ed25519 SPKI (SubjectPublicKeyInfo) DER header
// This is the standard ASN.1 structure for ed25519 public keys:
// SEQUENCE { AlgorithmIdentifier { OID 1.3.101.112 (ed25519) }, BIT STRING { 32-byte key } }
const ED25519_SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

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
    let key = publicKey;
    if (Buffer.isBuffer(publicKey)) {
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_HEADER, publicKey]),
        format: 'der',
        type: 'spki',
      });
    }
    return cryptoVerify(null, Buffer.from(message), key as KeyObject, signature);
  } catch {
    return false;
  }
}
