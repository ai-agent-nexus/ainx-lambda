import crypto from 'crypto';

export interface DidPair {
  did: string;
  signMessage: (message: string) => string;
}

/**
 * Generate a valid did:key with proper signature
 */
export function generateValidDid(): DidPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPublicKey = publicKeyDer.slice(-32);
  const multicodecPrefix = Buffer.from([0xed, 0x01]);
  const dataWithPrefix = Buffer.concat([multicodecPrefix, rawPublicKey]);

  const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let encoded = '';
  let num = BigInt('0x' + dataWithPrefix.toString('hex'));
  while (num > 0) {
    encoded = base58Chars[Number(num % BigInt(58))] + encoded;
    num = num / BigInt(58);
  }
  for (let i = 0; i < dataWithPrefix.length && dataWithPrefix[i] === 0; i++) {
    encoded = '1' + encoded;
  }

  const did = `did:key:z${encoded}`;

  const signMessage = (message: string): string => {
    const signature = crypto.sign(null, Buffer.from(message), privateKey);
    return signature.toString('base64');
  };

  return { did, signMessage };
}
