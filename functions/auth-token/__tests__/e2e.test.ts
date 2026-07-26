import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for auth-token Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end token issuance.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
const TOKEN_URL = `${API_BASE_URL}/auth/token`;

describe('E2E: auth-token', () => {
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
    it('should successfully generate token pair for valid DID', async () => {
      const { did, signMessage } = generateValidDid();

      // First, get a challenge
      const challengeResponse = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(challengeResponse.status).toBe(200);
      const challenge = challengeResponse.data.challenge;

      // Sign the challenge
      const signature = signMessage(challenge);

      // Request token
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

      expect(tokenResponse.status).toBe(200);
      expect(tokenResponse.data.access_token).toBeDefined();
      expect(tokenResponse.data.refresh_token).toBeDefined();
      expect(tokenResponse.data.expires_in).toBeDefined();
      expect(tokenResponse.data.token_type).toBe('Bearer');
    });
  });

  describe('Error Cases', () => {
    it('should return 400 for invalid DID format', async () => {
      try {
        await axios.post(
          TOKEN_URL,
          {
            did: 'invalid-did',
            challenge: 'test-challenge',
            signature: 'test-sig',
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
        expect(axiosError.response?.data.code).toBe('INVALID_DID');
      }
    });

    it('should return 400 for missing required fields', async () => {
      try {
        await axios.post(
          TOKEN_URL,
          { did: 'did:key:z6Mk...' },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('MISSING_FIELDS');
      }
    });

    it('should return 400 for invalid challenge', async () => {
      const { did, signMessage } = generateValidDid();

      // Sign a random challenge
      const challenge = 'invalid-challenge';
      const signature = signMessage(challenge);

      try {
        await axios.post(
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
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(400);
        expect(axiosError.response?.data.code).toBe('INVALID_CHALLENGE');
      }
    });

    it('should return 401 for invalid signature', async () => {
      const { did } = generateValidDid();

      // Get a valid challenge
      const challengeResponse = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const challenge = challengeResponse.data.challenge;

      // Use invalid signature
      try {
        await axios.post(
          TOKEN_URL,
          {
            did,
            challenge,
            signature: 'invalid-signature',
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(401);
        expect(axiosError.response?.data.code).toBe('INVALID_SIGNATURE');
      }
    });
  });

  describe('Security', () => {
    it('should handle large request body', async () => {
      const { did, signMessage } = generateValidDid();

      const challengeResponse = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const challenge = challengeResponse.data.challenge;
      const signature = signMessage(challenge);

      const tokenResponse = await axios.post(
        TOKEN_URL,
        {
          did,
          challenge,
          signature,
          extraField: 'x'.repeat(10000),
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(tokenResponse.status).toBe(200);
    });
  });
});
