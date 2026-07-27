import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for auth-revoke Lambda
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end token revocation.
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
const REGISTER_URL = `${API_BASE_URL}/agents/register`;

describe('E2E: auth-revoke', () => {
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
    it('should successfully revoke token', async () => {
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

      // Get token
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

      // Revoke token
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

    it('should revoke without refresh token', async () => {
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

      const revokeResponse = await axios.post(
        REVOKE_URL,
        {},
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
    it('should return 401 for missing Authorization header', async () => {
      try {
        await axios.post(
          REVOKE_URL,
          {},
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { message: string } } };
        expect(axiosError.response?.status).toBe(401);
        expect(axiosError.response?.data.message).toBe('Unauthorized');
      }
    });

    it('should return 403 for invalid token', async () => {
      try {
        await axios.post(
          REVOKE_URL,
          {},
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer invalid-token',
            },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { Message: string } } };
        expect(axiosError.response?.status).toBe(403);
        expect(axiosError.response?.data.Message).toBe(
          'User is not authorized to access this resource with an explicit deny in an identity-based policy'
        );
      }
    });
  });
});
