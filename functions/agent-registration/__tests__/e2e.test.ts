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
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    // Get the raw public key bytes (32 bytes for ed25519)
    // Node.js crypto doesn't directly expose raw bytes, so we extract from SPKI DER format
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    // ed25519 SPKI format: 12 byte header + 32 byte key
    const rawPublicKey = publicKeyDer.slice(-32);

    // Encode public key to base58 with multicodec prefix (0xed 0x01 for Ed25519)
    const multicodecPrefix = Buffer.from([0xed, 0x01]);
    const dataWithPrefix = Buffer.concat([multicodecPrefix, rawPublicKey]);

    const base58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let encoded = '';
    let num = BigInt('0x' + dataWithPrefix.toString('hex'));
    while (num > 0) {
      encoded = base58Chars[Number(num % BigInt(58))] + encoded;
      num = num / BigInt(58);
    }
    // Add leading zeros (represented as '1' in base58)
    for (let i = 0; i < dataWithPrefix.length && dataWithPrefix[i] === 0; i++) {
      encoded = '1' + encoded;
    }

    const did = `did:key:z${encoded}`;

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

  describe('Rotate Key', () => {
    it('should successfully rotate key for an active DID', async () => {
      // First register a DID
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      const registerResponse = await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      expect(registerResponse.status).toBe(201);

      // Generate new DID
      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();

      // Create rotate key signature
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      const rotateBody = {
        oldDid,
        newDid,
        signature: rotateSignature,
        timestamp,
        nonce,
      };

      const rotateResponse = await axios.post(
        API_GATEWAY_URL.replace('/register', '/rotate-key'),
        rotateBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(rotateResponse.status).toBe(200);
      expect(rotateResponse.data.message).toBe('Key rotated successfully');
      expect(rotateResponse.data.did).toBe(newDid);
    });

    it('should fail to rotate key with invalid signature', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();

      const rotateBody = {
        oldDid,
        newDid,
        signature: 'invalid-signature',
        timestamp,
        nonce,
      };

      try {
        await axios.post(API_GATEWAY_URL.replace('/register', '/rotate-key'), rotateBody, {
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

    it('should fail to rotate key with expired timestamp', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000) - 400; // Expired
      const nonce = crypto.randomUUID();

      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      const rotateBody = {
        oldDid,
        newDid,
        signature: rotateSignature,
        timestamp,
        nonce,
      };

      try {
        await axios.post(API_GATEWAY_URL.replace('/register', '/rotate-key'), rotateBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('TIMESTAMP_EXPIRED');
      }
    });

    it('should fail to rotate key with reused nonce', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();

      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      const rotateBody = {
        oldDid,
        newDid,
        signature: rotateSignature,
        timestamp,
        nonce,
      };

      // First rotate should succeed
      await axios.post(API_GATEWAY_URL.replace('/register', '/rotate-key'), rotateBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Second rotate with same nonce should fail
      try {
        await axios.post(API_GATEWAY_URL.replace('/register', '/rotate-key'), rotateBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('REUSED_NONCE');
      }
    });

    it('should fail to rotate key for already revoked DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // First rotate
      const { did: intermediateDid } = generateValidDid();
      const timestamp1 = Math.floor(Date.now() / 1000);
      const nonce1 = crypto.randomUUID();

      const rotateMessage1 = `POST /agents/rotate-key\nrotate:${oldDid}:${intermediateDid}:${timestamp1}:${nonce1}`;
      const rotateSignature1 = signMessage(rotateMessage1);

      await axios.post(
        API_GATEWAY_URL.replace('/register', '/rotate-key'),
        {
          oldDid,
          newDid: intermediateDid,
          signature: rotateSignature1,
          timestamp: timestamp1,
          nonce: nonce1,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // Second rotate with old DID should fail
      const { did: newDid } = generateValidDid();
      const timestamp2 = Math.floor(Date.now() / 1000);
      const nonce2 = crypto.randomUUID();

      const rotateMessage2 = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp2}:${nonce2}`;
      const rotateSignature2 = signMessage(rotateMessage2);

      try {
        await axios.post(
          API_GATEWAY_URL.replace('/register', '/rotate-key'),
          {
            oldDid,
            newDid,
            signature: rotateSignature2,
            timestamp: timestamp2,
            nonce: nonce2,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('DID_REVOKED');
      }
    });

    it('should fail to rotate key with duplicate new DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Register another DID
      const { did: existingDid, signMessage: existingSignMessage } = generateValidDid();
      const existingMessage = JSON.stringify({ did: existingDid, metadata });
      const existingSignature = existingSignMessage(existingMessage);

      await axios.post(
        API_GATEWAY_URL,
        {
          did: existingDid,
          signature: existingSignature,
          metadata,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // Try to rotate to existing DID
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();

      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${existingDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      try {
        await axios.post(
          API_GATEWAY_URL.replace('/register', '/rotate-key'),
          {
            oldDid,
            newDid: existingDid,
            signature: rotateSignature,
            timestamp,
            nonce,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(409);
        expect(axiosError.response?.data.code).toBe('DUPLICATE_DID');
      }
    });

    it('should handle concurrent rotate-key requests', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      const registerBody = {
        did: oldDid,
        signature,
        metadata,
      };

      await axios.post(API_GATEWAY_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Try concurrent rotations
      const { did: newDid1 } = generateValidDid();
      const { did: newDid2 } = generateValidDid();

      const timestamp = Math.floor(Date.now() / 1000);
      const nonce1 = crypto.randomUUID();
      const nonce2 = crypto.randomUUID();

      const rotateMessage1 = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid1}:${timestamp}:${nonce1}`;
      const rotateSignature1 = signMessage(rotateMessage1);

      const rotateMessage2 = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid2}:${timestamp}:${nonce2}`;
      const rotateSignature2 = signMessage(rotateMessage2);

      const [result1, result2] = await Promise.allSettled([
        axios.post(
          API_GATEWAY_URL.replace('/register', '/rotate-key'),
          {
            oldDid,
            newDid: newDid1,
            signature: rotateSignature1,
            timestamp,
            nonce: nonce1,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        ),
        axios.post(
          API_GATEWAY_URL.replace('/register', '/rotate-key'),
          {
            oldDid,
            newDid: newDid2,
            signature: rotateSignature2,
            timestamp,
            nonce: nonce2,
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        ),
      ]);

      // One should succeed, one should fail
      const successCount = [result1, result2].filter((r) => r.status === 'fulfilled').length;
      const failureCount = [result1, result2].filter((r) => r.status === 'rejected').length;

      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);
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
