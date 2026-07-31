import axios from 'axios';
import crypto from 'crypto';

/**
 * E2E Tests for Authentication API
 *
 * These tests call the actual API Gateway endpoint to verify end-to-end authentication flow.
 * Run with: API_GATEWAY_URL=<url> npm run test:e2e
 *
 * Requirements:
 * - API_GATEWAY_URL environment variable pointing to the deployed API Gateway
 * - AWS credentials for the test environment
 */

// Get API Gateway URL from environment or use default
const API_BASE_URL = process.env.API_GATEWAY_URL || 'http://localhost:3000';
const CHALLENGE_URL = `${API_BASE_URL}/auth/challenge`;
const TOKEN_URL = `${API_BASE_URL}/auth/token`;
const REFRESH_URL = `${API_BASE_URL}/auth/refresh`;
const REVOKE_URL = `${API_BASE_URL}/auth/revoke`;
const REGISTER_URL = `${API_BASE_URL}/agents/register`;

describe('E2E: Authentication Flow', () => {
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

  const registerDid = async (did: string, signMessage: (msg: string) => string) => {
    const metadata = { name: 'Test Agent' };
    const message = JSON.stringify({ did, metadata });
    const signature = signMessage(message);

    try {
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
    } catch (error) {
      if (axios.isAxiosError(error) && error.response) {
        console.error('registerDid failed:', {
          status: error.response.status,
          data: error.response.data,
        });
      }
      throw error;
    }
  };

  const getTokenPair = async (did: string, signMessage: (msg: string) => string) => {
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

    return {
      accessToken: tokenResponse.data.access_token,
      refreshToken: tokenResponse.data.refresh_token,
      expiresIn: tokenResponse.data.expires_in,
    };
  };

  describe('Happy Path: Complete Auth Flow', () => {
    it('should complete full authentication flow', async () => {
      const { did, signMessage } = generateValidDid();

      // Register the DID first
      await registerDid(did, signMessage);

      // Get token pair
      const { accessToken, refreshToken, expiresIn } = await getTokenPair(did, signMessage);

      expect(accessToken).toBeDefined();
      expect(typeof accessToken).toBe('string');
      expect(accessToken.length).toBeGreaterThan(0);

      expect(refreshToken).toBeDefined();
      expect(typeof refreshToken).toBe('string');
      expect(refreshToken.length).toBeGreaterThan(0);

      expect(expiresIn).toBeDefined();
      expect(typeof expiresIn).toBe('number');
      expect(expiresIn).toBeGreaterThan(0);
    });

    it('should refresh access token with refresh token', async () => {
      const { did, signMessage } = generateValidDid();

      await registerDid(did, signMessage);

      const { refreshToken } = await getTokenPair(did, signMessage);

      // Refresh token
      const refreshResponse = await axios.post(
        REFRESH_URL,
        { refresh_token: refreshToken },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      expect(refreshResponse.status).toBe(200);
      expect(refreshResponse.data.access_token).toBeDefined();
      expect(refreshResponse.data.refresh_token).toBeDefined();
      expect(refreshResponse.data.access_token).not.toBe(refreshToken);
    });

    it('should revoke token successfully', async () => {
      const { did, signMessage } = generateValidDid();

      await registerDid(did, signMessage);

      const { accessToken, refreshToken } = await getTokenPair(did, signMessage);

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

      const { accessToken } = await getTokenPair(did, signMessage);

      // Revoke without refresh token
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

  describe('Auth Challenge', () => {
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

  describe('Auth Token', () => {
    it('should successfully generate token pair for valid DID', async () => {
      const { did, signMessage } = generateValidDid();

      await registerDid(did, signMessage);

      const { accessToken, refreshToken, expiresIn } = await getTokenPair(did, signMessage);

      expect(accessToken).toBeDefined();
      expect(refreshToken).toBeDefined();
      expect(expiresIn).toBeDefined();
    });

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

    it('should return 401 for unregistered DID', async () => {
      const { did, signMessage } = generateValidDid();

      // Get challenge without registering
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
        expect(axiosError.response?.status).toBe(401);
        expect(axiosError.response?.data.code).toBe('DID_NOT_FOUND');
      }
    });
  });

  describe('Auth Refresh', () => {
    it('should return 401 for invalid refresh token', async () => {
      try {
        await axios.post(
          REFRESH_URL,
          { refresh_token: 'invalid-token' },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
          }
        );
        throw new Error('Expected request to fail');
      } catch (error: unknown) {
        const axiosError = error as { response?: { status: number; data: { code: string } } };
        expect(axiosError.response?.status).toBe(401);
        expect(axiosError.response?.data.code).toBe('INVALID_REFRESH_TOKEN');
      }
    });

    it('should return 400 for missing refresh token', async () => {
      try {
        await axios.post(
          REFRESH_URL,
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

  describe('Auth Revoke', () => {
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
        const axiosError = error as { response?: { status: number } };
        expect(axiosError.response?.status).toBe(403);
      }
    });
  });

  describe('Security', () => {
    it('should handle large DID values in challenge', async () => {
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

    it('should handle large request body in token request', async () => {
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
