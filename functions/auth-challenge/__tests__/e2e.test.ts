import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for auth-challenge Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end challenge generation.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;

describe('E2E: auth-challenge', () => {
  const generateValidDid = () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
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
    return { did };
  };

  describe('Happy Path', () => {
    it('should successfully generate challenge for valid DID', async () => {
      const { did } = generateValidDid();

      const response = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.challenge).toBeDefined();
      expect(typeof response.data.challenge).toBe('string');
      expect(response.data.challenge.length).toBeGreaterThan(0);
      expect(response.data.expires_at).toBeDefined();
    });

    it('should generate different challenges for same DID', async () => {
      const { did } = generateValidDid();

      const response1 = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const response2 = await axios.post(
        CHALLENGE_URL,
        { did },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(response1.data.challenge).not.toBe(response2.data.challenge);
    });
  });

  describe('Error Cases', () => {
    it('should return 400 for invalid DID format', async () => {
      try {
        await axios.post(
          CHALLENGE_URL,
          { did: 'invalid-did' },
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

    it('should return 400 for missing DID', async () => {
      try {
        await axios.post(
          CHALLENGE_URL,
          {},
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
  });

  describe('Security', () => {
    it('should handle large DID values', async () => {
      const { did } = generateValidDid();
      const largeDid = did + 'a'.repeat(1000);

      try {
        await axios.post(
          CHALLENGE_URL,
          { did: largeDid },
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
  });
});
