import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for Agent Management API
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end functionality.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

// Get API Gateway URL from environment or use default
const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const REGISTER_URL = `${API_BASE_URL}/agents/register`;
const ROTATE_KEY_URL = `${API_BASE_URL}/agents/rotate-key`;
const REVOKE_URL = `${API_BASE_URL}/agents`;
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
const TOKEN_URL = `${API_BASE_URL}/auth/token`;

describe('E2E: Agent Management', () => {
  // Generate a valid did:key with proper signature
  const generateValidDid = () => {
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
  };

  const getJwtToken = async (did: string, signMessage: (msg: string) => string) => {
    // Step 1: Get challenge
    const challengeResponse = await axios.post(
      CHALLENGE_URL,
      { did },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    const challenge = challengeResponse.data.challenge;

    // Step 2: Sign challenge
    const signature = signMessage(challenge);

    // Step 3: Get token
    const tokenResponse = await axios.post(
      TOKEN_URL,
      {
        did,
        challenge,
        signature,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    return tokenResponse.data.access_token;
  };

  describe('Happy Path: Agent Registration', () => {
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

      const response = await axios.post(REGISTER_URL, requestBody, {
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

      const response = await axios.post(REGISTER_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      expect(response.status).toBe(201);
      expect(response.data.did).toBe(requestBody.did);
    });
  });

  describe('Happy Path: Key Rotation', () => {
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

      const registerResponse = await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      expect(registerResponse.status).toBe(201);

      // Get JWT token for authentication
      const jwtToken = await getJwtToken(oldDid, signMessage);

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

      const rotateResponse = await axios.post(ROTATE_KEY_URL, rotateBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
        },
        timeout: 10000,
      });

      expect(rotateResponse.status).toBe(200);
      expect(rotateResponse.data.message).toBe('Key rotated successfully');
      expect(rotateResponse.data.did).toBe(newDid);
    });
  });

  describe('Happy Path: Agent Revocation', () => {
    it('should successfully revoke an agent', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);

      const registerResponse = await axios.post(
        REGISTER_URL,
        {
          did,
          signature,
          metadata,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );
      expect(registerResponse.status).toBe(201);

      const jwtToken = await getJwtToken(did, signMessage);

      try {
        const revokeResponse = await axios.delete(`${REVOKE_URL}/${did}`, {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
          timeout: 10000,
        });

        expect(revokeResponse.status).toBe(200);
        expect(revokeResponse.data.message).toBe('Agent revoked successfully');
        expect(revokeResponse.data.did).toBe(did);
      } catch (error: unknown) {
        const axiosError = error as {
          response?: { status: number; data: Record<string, unknown> };
        };
        console.error('Revoke failed:', {
          status: axiosError.response?.status,
          data: axiosError.response?.data,
        });
        throw error;
      }
    });
  });

  describe('Error Cases: Agent Registration', () => {
    it('should return 400 for invalid DID format', async () => {
      const requestBody = {
        did: 'invalid-did-format',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: { name: 'Test' },
      };

      try {
        await axios.post(REGISTER_URL, requestBody, {
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
        await axios.post(REGISTER_URL, requestBody, {
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
      const firstResponse = await axios.post(REGISTER_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      expect(firstResponse.status).toBe(201);

      // Second registration with same DID
      try {
        await axios.post(REGISTER_URL, requestBody, {
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
        await axios.post(REGISTER_URL, requestBody, {
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

  describe('Error Cases: Key Rotation', () => {
    it('should fail to rotate key with invalid signature', async () => {
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

      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Get JWT token
      const jwtToken = await getJwtToken(oldDid, signMessage);

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
        await axios.post(ROTATE_KEY_URL, rotateBody, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtToken}`,
          },
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

      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Get JWT token
      const jwtToken = await getJwtToken(oldDid, signMessage);

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
        await axios.post(ROTATE_KEY_URL, rotateBody, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtToken}`,
          },
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

      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Get JWT token
      const jwtToken = await getJwtToken(oldDid, signMessage);

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
      await axios.post(ROTATE_KEY_URL, rotateBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
        },
        timeout: 10000,
      });

      // Second rotate with same nonce should fail
      try {
        await axios.post(ROTATE_KEY_URL, rotateBody, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtToken}`,
          },
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

      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Get JWT token
      const jwtToken = await getJwtToken(oldDid, signMessage);

      // First rotate
      const { did: intermediateDid } = generateValidDid();
      const timestamp1 = Math.floor(Date.now() / 1000);
      const nonce1 = crypto.randomUUID();

      const rotateMessage1 = `POST /agents/rotate-key\nrotate:${oldDid}:${intermediateDid}:${timestamp1}:${nonce1}`;
      const rotateSignature1 = signMessage(rotateMessage1);

      await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid,
          newDid: intermediateDid,
          signature: rotateSignature1,
          timestamp: timestamp1,
          nonce: nonce1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwtToken}`,
          },
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
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid,
            signature: rotateSignature2,
            timestamp: timestamp2,
            nonce: nonce2,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jwtToken}`,
            },
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

      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Get JWT token
      const jwtToken = await getJwtToken(oldDid, signMessage);

      // Register another DID
      const { did: existingDid, signMessage: existingSignMessage } = generateValidDid();
      const existingMessage = JSON.stringify({ did: existingDid, metadata });
      const existingSignature = existingSignMessage(existingMessage);

      await axios.post(
        REGISTER_URL,
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
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid: existingDid,
            signature: rotateSignature,
            timestamp,
            nonce,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${jwtToken}`,
            },
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
  });

  describe('Error Cases: Agent Revocation', () => {
    it('should return 401 for missing Authorization header', async () => {
      const { did } = generateValidDid();

      try {
        await axios.delete(`${REVOKE_URL}/${did}`, {
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });

    it('should return 403 for invalid token', async () => {
      const { did } = generateValidDid();

      try {
        await axios.delete(`${REVOKE_URL}/${did}`, {
          headers: {
            Authorization: 'Bearer invalid-token',
          },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(403);
      }
    });

    it('should return 403 for unauthorized DID revocation', async () => {
      const { did: registeredDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: registeredDid, metadata });
      const signature = signMessage(message);

      await axios.post(
        REGISTER_URL,
        { did: registeredDid, signature, metadata },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const jwtToken = await getJwtToken(registeredDid, signMessage);

      const { did: otherDid } = generateValidDid();

      try {
        await axios.delete(`${REVOKE_URL}/${otherDid}`, {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(403);
        expect(axiosError.response?.data.code).toBe('INSUFFICIENT_SCOPE');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty request body', async () => {
      try {
        await axios.post(
          REGISTER_URL,
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

      const response = await axios.post(REGISTER_URL, requestBody, {
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

      const response = await axios.post(REGISTER_URL, requestBody, {
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

      try {
        const response = await axios.post(REGISTER_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        });

        expect(response.status).toBe(201);
        expect(response.data.message).toBe('Agent registered successfully');
      } catch (error) {
        if (axios.isAxiosError(error) && error.response) {
          console.error('XSS test failed with response:', {
            status: error.response.status,
            data: error.response.data,
            headers: error.response.headers,
          });
        }
        throw error;
      }
    });
  });
});
