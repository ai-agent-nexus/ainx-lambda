import { verifySignature } from '../src/index';

describe('verifySignature', () => {
  it('should verify a valid signature', () => {
    const { publicKey, signature, message } = generateTestKeyPair();
    
    const result = verifySignature(publicKey, message, signature);

    expect(result).toBe(true);
  });

  it('should reject an invalid signature', () => {
    const { publicKey, message } = generateTestKeyPair();
    const invalidSignature = Buffer.from('invalid-signature-data');
    
    const result = verifySignature(publicKey, message, invalidSignature);

    expect(result).toBe(false);
  });

  it('should reject signature with wrong key', () => {
    const { message, signature } = generateTestKeyPair();
    const { publicKey: wrongPublicKey } = generateTestKeyPair();
    
    const result = verifySignature(wrongPublicKey, message, signature);

    expect(result).toBe(false);
  });

  it('should throw on invalid public key', () => {
    expect(() => verifySignature(null as unknown as Buffer, 'message', Buffer.from('sig'))).toThrow('Public key must be provided');
  });

  it('should throw on invalid message', () => {
    const { publicKey } = generateTestKeyPair();
    expect(() => verifySignature(publicKey, '', Buffer.from('sig'))).toThrow('Message must be a non-empty string');
    expect(() => verifySignature(publicKey, null as unknown as string, Buffer.from('sig'))).toThrow('Message must be a non-empty string');
  });

  it('should throw on invalid signature', () => {
    const { publicKey } = generateTestKeyPair();
    expect(() => verifySignature(publicKey, 'message', null as unknown as Buffer)).toThrow('Signature must be a Buffer');
    expect(() => verifySignature(publicKey, 'message', 'not-a-buffer' as unknown as Buffer)).toThrow('Signature must be a Buffer');
  });
});

function generateTestKeyPair(): { publicKey: any; privateKey: any; message: string; signature: Buffer } {
  const { generateKeyPairSync, sign } = require('crypto');
  
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  const message = 'test-message-for-signature-verification';
  
  const signature = sign(null, Buffer.from(message), privateKey);

  return { publicKey, privateKey, message, signature };
}
