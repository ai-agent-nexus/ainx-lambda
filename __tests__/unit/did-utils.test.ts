import { parseDidKey } from '../../packages/did-utils/src/index';

describe('parseDidKey', () => {
  it('should parse a valid did:key with ed25519', () => {
    const did = 'did:key:z6MkhaXg9v2UWbBsP7U1BP5B5iGTLfzfZoXRWwAHSidk8bRk';

    const result = parseDidKey(did);

    expect(result.method).toBe('key');
    expect(result.keyType).toBe('ed25519');
    expect(result.publicKey).toBeInstanceOf(Buffer);
    expect(result.publicKey.length).toBe(32);
  });

  it('should throw on invalid format', () => {
    const invalidDids = ['', 'not-a-did', 'did:', 'did:key'];

    invalidDids.forEach((did) => {
      expect(() => parseDidKey(did)).toThrow('Invalid DID');
    });
  });

  it('should throw on unsupported method', () => {
    const did = 'did:web:example.com';

    expect(() => parseDidKey(did)).toThrow('Unsupported DID method: web');
  });

  it('should throw on non-z-prefix multibase', () => {
    const did = 'did:key:a6MkhaXg9v2UWbBsP7U1BP5B5iGTLfzfZoXRWwAHSidk8bRk';

    expect(() => parseDidKey(did)).toThrow('Invalid multibase encoding');
  });

  it('should throw on invalid base58 characters', () => {
    const did = 'did:key:z6MkhaXg9v2UWbBsP7U1BP5B5iGTLfzfZoXRWwAHSidk8bRk!@#';

    expect(() => parseDidKey(did)).toThrow('Invalid base58 character');
  });

  it('should throw on empty string', () => {
    expect(() => parseDidKey('')).toThrow('Invalid DID: must be a non-empty string');
  });

  it('should throw on null input', () => {
    expect(() => parseDidKey(null as unknown as string)).toThrow(
      'Invalid DID: must be a non-empty string'
    );
  });
});
