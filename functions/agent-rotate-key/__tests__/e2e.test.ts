import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for agent-rotate-key Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end key rotation.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const REGISTER_URL = `${API_BASE_URL}/agents/register`;
const ROTATE_KEY_URL = `${API_BASE_URL}/agents/rotate-key`;

describe('E2E: agent-rotate-key', () => {
  const generateAuthToken = (did: string, signMessage: (msg: string) => string): string => {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    const authMessage = `auth:${did}:${timestamp}:${nonce}`;
    const authSignature = signMessage(authMessage);
    return `${did}:${authSignature}:${timestamp}:${nonce}`;
  };

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

  describe('Happy Path', () => {
    it('should successfully rotate key for active DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register the DID
      const registerBody = { did: oldDid, signature, metadata };
      const registerResponse = await axios.post(REGISTER_URL, registerBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: generateAuthToken(oldDid, signMessage),
        },
        timeout: 10000,
      });
      expect(registerResponse.status).toBe(201);

      // Rotate key
      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      const rotateResponse = await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid,
          newDid,
          signature: rotateSignature,
          timestamp,
          nonce,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      expect(rotateResponse.status).toBe(200);
      expect(rotateResponse.data.message).toBe('Key rotated successfully');
      expect(rotateResponse.data.did).toBe(newDid);
      expect(rotateResponse.data.updatedAt).toBeDefined();
    });

    it('should allow operations with new DID after rotation', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      // Rotate
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
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      // Try to rotate again with new DID
      const { did: anotherNewDid } = generateValidDid();
      const timestamp2 = Math.floor(Date.now() / 1000);
      const nonce2 = crypto.randomUUID();
      const rotateMessage2 = `POST /agents/rotate-key\nrotate:${newDid}:${anotherNewDid}:${timestamp2}:${nonce2}`;
      const rotateSignature2 = signMessage(rotateMessage2);

      const secondRotateResponse = await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid: newDid,
          newDid: anotherNewDid,
          signature: rotateSignature2,
          timestamp: timestamp2,
          nonce: nonce2,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      expect(secondRotateResponse.status).toBe(200);
    });
  });

  describe('Error Cases', () => {
    it('should return 400 for invalid signature', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid,
            signature: 'invalid-signature',
            timestamp,
            nonce,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: generateAuthToken(oldDid, signMessage),
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('INVALID_SIGNATURE');
      }
    });

    it('should return 400 for expired timestamp', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      const { did: newDid } = generateValidDid();
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
      const nonce = crypto.randomUUID();
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${expiredTimestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid,
            signature: rotateSignature,
            timestamp: expiredTimestamp,
            nonce,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: generateAuthToken(oldDid, signMessage),
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('TIMESTAMP_EXPIRED');
      }
    });

    it('should return 400 for reused nonce', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

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

      // First rotation
      await axios.post(ROTATE_KEY_URL, rotateBody, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: generateAuthToken(oldDid, signMessage),
        },
        timeout: 10000,
      });

      // Second rotation with same nonce
      try {
        await axios.post(ROTATE_KEY_URL, rotateBody, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
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

    it('should return 400 for revoked old DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      // First rotation
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
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      // Try to rotate with revoked DID
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
              Authorization: generateAuthToken(oldDid, signMessage),
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

    it('should return 409 for duplicate new DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register old DID
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      // Register another DID
      const { did: existingDid, signMessage: existingSign } = generateValidDid();
      const existingMessage = JSON.stringify({ did: existingDid, metadata });
      const existingSignature = existingSign(existingMessage);

      await axios.post(
        REGISTER_URL,
        { did: existingDid, signature: existingSignature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
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
              Authorization: generateAuthToken(oldDid, signMessage),
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

  describe('Security', () => {
    it('should handle SQL injection attempt in DID', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:did:key:z6Mk malicious:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      try {
        await axios.post(
          ROTATE_KEY_URL,
          {
            oldDid,
            newDid: 'did:key:z6Mk malicious',
            signature: rotateSignature,
            timestamp,
            nonce,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: generateAuthToken(oldDid, signMessage),
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(400);
      }
    });

    it('should handle large request body', async () => {
      const { did: oldDid, signMessage } = generateValidDid();
      const metadata = { name: 'Test Agent' };
      const message = JSON.stringify({ did: oldDid, metadata });
      const signature = signMessage(message);

      // Register
      await axios.post(
        REGISTER_URL,
        { did: oldDid, signature, metadata },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      const { did: newDid } = generateValidDid();
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomUUID();
      const rotateMessage = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
      const rotateSignature = signMessage(rotateMessage);

      const rotateResponse = await axios.post(
        ROTATE_KEY_URL,
        {
          oldDid,
          newDid,
          signature: rotateSignature,
          timestamp,
          nonce,
          extraField: 'x'.repeat(10000),
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: generateAuthToken(oldDid, signMessage),
          },
          timeout: 10000,
        }
      );

      expect(rotateResponse.status).toBe(200);
    });
  });
});
