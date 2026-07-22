import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for agent-registration
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end functionality.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

// Get API Gateway URL from environment or use default
const API_GATEWAY_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000/agents/register';

describe('E2E: agent-registration', () => {
  // Generate a valid did:key with proper signature
  const generateValidDid = () => {
    // Generate an ed25519 key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');;
    
    // Get the raw public key bytes (32 bytes for ed25519)
    const publicKeyBytes = publicKey.export({ format: 'jwk' });
    // For ed25519, we need to extract the raw 32-byte key
    // Node.js crypto doesn't directly expose raw bytes, so we'll use a workaround
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    // ed25519 SPKI format: 12 byte header + 32 byte key
    const rawPublicKey = publicKeyDer.slice(-32);
    
    // Encode public key to base58
    const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let encoded = '';
    let num = BigInt('0x' + rawPublicKey.toString('hex'));
    while (num > 0) {
      encoded = base58Chars[Number(num % BigInt(58))] + encoded;
      num = num / BigInt(58);
    }
    // Add leading zeros (represented as '1' in base58)
    for (let i = 0; i < rawPublicKey.length && rawPublicKey[i] === 0; i++) {
      encoded = '1' + encoded;
    }
    
    const did = `did:key:z6Mk${encoded}`;
    
    // Create a signer function that signs messages
    const signMessage = (message: string): string => {
      const signature = crypto.sign(null, Buffer.from(message), privateKey);
      return signature.toString('base64');
    };
    
    return { did, signMessage };
  };

  describe('Happy Path', () => {
    it('should successfully register a new agent with valid did:key', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = {
        name: 'Test Agent',
        description: 'A test agent for E2E testing',
      };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata,
      };

      const response = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      expect(response.status).toBe(201);
      expect(response.data.message).toBe('Agent registered successfully');
      expect(response.data.did).toBe(requestBody.did);
      expect(response.data.registeredAt).toBeDefined();
      expect(response.data.ttl).toBeDefined();
    });

    it('should accept minimal metadata', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = {};
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata,
      };

      const response = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      expect(response.status).toBe(201);
      expect(response.data.did).toBe(requestBody.did);
    });
  });

  describe('Error Cases', () => {
    it('should return 400 for invalid DID format', async () => {
      const requestBody = {
        did: 'invalid-did-format',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: { name: 'Test' },
      };

      try {
        await axios.post(API_GATEWAY_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('INVALID_DID');
      }
    });

    it('should return 400 for missing required fields', async () => {
      const requestBody = {
        did: generateValidDid().did,
        // missing signature and metadata
      };

      try {
        await axios.post(API_GATEWAY_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('MISSING_FIELDS');
      }
    });

    it('should return 409 for duplicate DID registration', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = { name: 'Test' };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata,
      };

      // First registration
      const firstResponse = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      expect(firstResponse.status).toBe(201);

      // Second registration with same DID
      try {
        await axios.post(API_GATEWAY_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(409);
        expect(axiosError.response?.data.code).toBe('DUPLICATE_DID');
      }
    });

    it('should return 400 for invalid signature', async () => {
      const { did } = generateValidDid();
      const requestBody = {
        did,
        signature: 'invalid-signature',
        metadata: { name: 'Test' },
      };

      try {
        await axios.post(API_GATEWAY_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('INVALID_SIGNATURE');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty request body', async () => {
      try {
        await axios.post(
          API_GATEWAY_URL,
          {},
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(400);
      }
    });

    it('should handle large metadata', async () => {
      const largeMetadata = {
        name: 'Test',
        data: 'x'.repeat(10000),
      };

      const { did, signMessage } = generateValidDid();
      const message = JSON.stringify({ did, metadata: largeMetadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata: largeMetadata,
      };

      const response = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      expect(response.status).toBe(201);
    });
  });

  describe('Security', () => {
    it('should handle SQL injection attempt in metadata', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = {
        name: "'; DROP TABLE agents; --",
      };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata,
      };

      const response = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Should still succeed, DynamoDB is NoSQL
      expect(response.status).toBe(201);
    });

    it('should handle XSS attempt in metadata', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = {
        name: '<script>alert("xss")</script>',
      };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);
      
      const requestBody = {
        did,
        signature,
        metadata,
      };

      const response = await axios.post(API_GATEWAY_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      expect(response.status).toBe(201);
      expect(response.data.message).toBe('Agent registered successfully');
    });
  });
});