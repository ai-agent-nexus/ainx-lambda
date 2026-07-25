import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for auth Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end authentication.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const REGISTER_URL = `${API_BASE_URL}/agents/register`;
const ROTATE_KEY_URL = `${API_BASE_URL}/agents/rotate-key`;

describe('E2E: auth Lambda', () => {
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

  describe('Authentication flow', () => {
    it('should authenticate with valid token', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);

      // Register the DID first
      const registerBody = { did, signature, metadata };
      const registerResponse = await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      expect(registerResponse.status).toBe(201);

      // Create auth token
      const timestamp = Math.floor(Date.now() / 1000);
      const authMessage = `auth:${did}:${timestamp}`;
      const authSignature = signMessage(authMessage);
      const token = `${did}:${authSignature}:${timestamp}`;

      // Call protected endpoint with auth token
      const rotateResponse = await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid: did,
          newDid: generateValidDid().did,
          signature: authSignature,
          timestamp,
          nonce: crypto.randomUUID(),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      expect(rotateResponse.status).toBe(200);
    });

    it('should reject authentication with invalid token', async () => {
      const { did } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const token = `${did}:invalid-signature:${timestamp}`;

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid: did,
            newDid: generateValidDid().did,
            signature: 'invalid',
            timestamp,
            nonce: crypto.randomUUID(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });

    it('should reject authentication with expired token', async () => {
      const { did, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did, metadata });
      const signature = signMessage(message);

      // Register the DID
      const registerBody = { did, signature, metadata };
      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Create expired token
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
      const authMessage = `auth:${did}:${expiredTimestamp}`;
      const authSignature = signMessage(authMessage);
      const token = `${did}:${authSignature}:${expiredTimestamp}`;

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid: did,
            newDid: generateValidDid().did,
            signature: authSignature,
            timestamp: expiredTimestamp,
            nonce: crypto.randomUUID(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });

    it('should reject authentication for revoked DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register the DID
      const registerBody = { did: oldDid, signature, metadata };
      await axios.post(REGISTER_URL, registerBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });

      // Rotate the key (revokes old DID)
      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid,
          newDid,
          signature: rotateSignature,
          timestamp,
          nonce,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      // Try to authenticate with revoked DID
      const authTimestamp = Math.floor(Date.now() / 1000);
      const authMessage = `auth:${oldDid}:${authTimestamp}`;
      const authSignature = signMessage(authMessage);
      const token = `${oldDid}:${authSignature}:${authTimestamp}`;

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid: generateValidDid().did,
            signature: authSignature,
            timestamp: authTimestamp,
            nonce: crypto.randomUUID(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });
  });

  describe('Token format edge cases', () => {
    it('should handle missing authorization header', async () => {
      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid: generateValidDid().did,
            newDid: generateValidDid().did,
            signature: 'test',
            timestamp: Math.floor(Date.now() / 1000),
            nonce: crypto.randomUUID(),
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });

    it('should handle malformed token', async () => {
      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid: generateValidDid().did,
            newDid: generateValidDid().did,
            signature: 'test',
            timestamp: Math.floor(Date.now() / 1000),
            nonce: crypto.randomUUID(),
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer malformed-token',
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });
  });
});
