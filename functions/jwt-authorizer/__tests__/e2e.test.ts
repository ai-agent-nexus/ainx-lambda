import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for jwt-authorizer Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end JWT authorization.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
const TOKEN_URL = `${API_BASE_URL}/auth/token`;
const REVOKE_URL = `${API_BASE_URL}/auth/revoke`;
const AGENTS_URL = `${API_BASE_URL}/agents`;
const REGISTER_URL = `${API_BASE_URL}/agents/register`;

describe('E2E: jwt-authorizer', () => {
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

  const registerDid = async (did: string, signMessage: (msg: string) => string) => {
    const metadata = { name: 'Test Agent' };
    const message = JSON.stringify({ did, metadata });
    const signature = signMessage(message);

    await axios.post(
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
  };

  describe('Happy Path', () => {
    it('should allow access with valid JWT', async () => {
      const { did, signMessage } = generateValidDid();

      await registerDid(did, signMessage);

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
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const accessToken = tokenResponse.data.access_token;
      const refreshToken = tokenResponse.data.refresh_token;

      const revokeResponse = await axios.post(
        REVOKE_URL,
        { refresh_token: refreshToken },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        }
      );

      expect(revokeResponse.status).toBe(200);
      expect(revokeResponse.data.message).toBe('Token revoked successfully');
    });
  });

  describe('Error Cases', () => {
    it('should deny access with missing token', async () => {
      try {
        await axios.delete(`${AGENTS_URL}/did:key:z6Mktest`, {
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(401);
      }
    });

    it('should deny access with invalid token', async () => {
      try {
        await axios.delete(`${AGENTS_URL}/did:key:z6Mktest`, {
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

    it('should deny access with revoked token', async () => {
      const { did, signMessage } = generateValidDid();

      await registerDid(did, signMessage);

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
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const accessToken = tokenResponse.data.access_token;
      const refreshToken = tokenResponse.data.refresh_token;

      await axios.post(
        REVOKE_URL,
        { refresh_token: refreshToken },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        }
      );

      try {
        await axios.get(AGENTS_URL, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        });
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(403);
      }
    });
  });
});
