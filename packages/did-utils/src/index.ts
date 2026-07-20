export interface ParsedDidKey {
  method: string;
  publicKey: Buffer;
  keyType: string;
}

export function parseDidKey(did: string): ParsedDidKey {
  if (!did || typeof did !== 'string') {
    throw new Error('Invalid DID: must be a non-empty string');
  }

  const didPattern = /^did:(\w+):(.+)$/;
  const match = did.match(didPattern);

  if (!match) {
    throw new Error(`Invalid DID format: ${did}`);
  }

  const method = match[1];
  const methodSpecificId = match[2];

  if (method !== 'key') {
    throw new Error(`Unsupported DID method: ${method}`);
  }

  const multibaseKey = methodSpecificId;

  if (!multibaseKey.startsWith('z')) {
    throw new Error('Invalid multibase encoding: expected base58btc (z-prefix)');
  }

  const base58 = multibaseKey.slice(1);
  const decoded = base58Decode(base58);

  if (decoded.length < 2) {
    throw new Error('Invalid public key: insufficient data');
  }

  const keyType = 'ed25519';
  const publicKey = decoded.slice(2);

  if (publicKey.length !== 32) {
    throw new Error(`Invalid ed25519 public key length: expected 32 bytes, got ${publicKey.length}`);
  }

  return {
    method,
    publicKey,
    keyType,
  };
}

function base58Decode(str: string): Buffer {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base = BigInt(58);
  let result = BigInt(0);

  for (const char of str) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }
    result = result * base + BigInt(index);
  }

  if (result === BigInt(0)) {
    return Buffer.alloc(0);
  }

  const hex = result.toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  return Buffer.from(padded, 'hex');
}
