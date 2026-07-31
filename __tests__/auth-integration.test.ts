process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
process.env.JWT_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgwMbRvI0MBZhpI
A7UL6gC8NL1E9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9
j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
-----END RSA PRIVATE KEY-----`;
process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWy
F8PbnGy0AHB7MhgwMbRvI0MBZhpIA7UL6gC8NL1E9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
-----END PUBLIC KEY-----`;
process.env.JWT_ISSUER = 'ainx-api';
process.env.JWT_EXPIRES_IN_SECONDS = '3600';
process.env.REFRESH_TOKEN_TTL_DAYS = '7';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as challengeHandler } from '../functions/auth-challenge/src/index';
import { handler as tokenHandler } from '../functions/auth-token/src/index';
import { handler as refreshHandler } from '../functions/auth-refresh/src/index';
import { handler as revokeHandler } from '../functions/auth-revoke/src/index';

// Mock dependencies
jest.mock('@ainx/logger');

jest.mock('@ainx/shared-utils', () => ({
  formatResponse: jest.fn((statusCode: number, body: Record<string, unknown>) => ({
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    },
    body: JSON.stringify(body),
  })),
  validateInput: jest.fn((input: Record<string, unknown>, requiredFields: string[]) => {
    const missingFields = requiredFields.filter((field) => !input[field]);
    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }),
  parseBody: jest.fn((body: string | null) => {
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }),
}));

jest.mock('@ainx/did-utils', () => ({
  parseDidKey: jest.fn((did: string) => {
    if (!did || !did.startsWith('did:key:')) {
      throw new Error('Invalid DID format');
    }
    return {
      method: 'key',
      publicKey: Buffer.from('a'.repeat(32)),
      keyType: 'ed25519',
    };
  }),
}));

jest.mock('@ainx/crypto-utils', () => ({
  verifySignature: jest.fn((_publicKey: Buffer, message: string, signature: Buffer) => {
    // For testing, accept any signature for valid messages
    return signature.length > 0 && message.length > 0;
  }),
}));

// Track DynamoDB state for integration tests
const dynamoDBState = {
  challenges: new Map<string, unknown>(),
  agents: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
  tokenBlacklist: new Map<string, unknown>(),
};

// Mock the DynamoDB client - use a single mockSend that can be controlled
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => params),
  TransactWriteCommand: jest.fn((params) => params),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-access-token'),
  verify: jest.fn(() => ({
    sub: 'test-user-id',
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'ainx-api',
    jti: 'test-jti-123',
    scope: 'agent:read agent:write',
  })),
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor() {
      super('Token expired');
      this.name = 'TokenExpiredError';
    }
  },
  JsonWebTokenError: class JsonWebTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'JsonWebTokenError';
    }
  },
}));

describe('Integration: Authentication Flow', () => {
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';

  beforeEach(() => {
    // Clear all DynamoDB state before each test
    dynamoDBState.challenges.clear();
    dynamoDBState.agents.clear();
    dynamoDBState.refreshTokens.clear();
    dynamoDBState.tokenBlacklist.clear();

    // Setup environment variables
    process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.TOKEN_BLACKLIST_TABLE_NAME = 'test-token-blacklist-table';
    process.env.JWT_PRIVATE_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgwMbRvI0MBZhpI
A7UL6gC8NL1E9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9
j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
-----END RSA PRIVATE KEY-----`;
    process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWy
F8PbnGy0AHB7MhgwMbRvI0MBZhpIA7UL6gC8NL1E9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
-----END PUBLIC KEY-----`;
    process.env.JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Z3VS5JJcds3xfn/ygWy
F8PbnGy0AHB7MhgwMbRvI0MBZhpIA7UL6gC8NL1E9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j9j
-----END PUBLIC KEY-----`;
    process.env.JWT_EXPIRES_IN_SECONDS = '3600';
    process.env.REFRESH_TOKEN_TTL_DAYS = '7';
    process.env.BLACKLIST_TTL_SECONDS = '3600';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full auth flow with shared state', () => {
    it('should handle complete challenge -> token -> refresh -> revoke flow', async () => {
      // Step 1: Generate challenge
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      const challengeResult = await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      expect(challengeResult.statusCode).toBe(200);
      const challengeBody = JSON.parse(challengeResult.body);
      expect(challengeBody.challenge).toBeDefined();

      // Verify challenge stored in shared state
      const storedChallenge = dynamoDBState.challenges.get(validDid);
      expect(storedChallenge).toBeDefined();

      // Step 2: Setup agent in shared state
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      // Step 3: Get token
      const tokenEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/token',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          challenge: challengeBody.challenge,
          signature: 'valid-signature',
        }),
      };

      const tokenResult = await tokenHandler(tokenEvent as APIGatewayProxyEvent);
      expect(tokenResult.statusCode).toBe(200);
      const tokenBody = JSON.parse(tokenResult.body);
      expect(tokenBody.access_token).toBeDefined();
      expect(tokenBody.refresh_token).toBeDefined();

      // Verify challenge was deleted after use
      expect(dynamoDBState.challenges.has(validDid)).toBe(false);

      // Step 4: Refresh token
      const refreshEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/refresh',
        httpMethod: 'POST',
        body: JSON.stringify({ refresh_token: tokenBody.refresh_token }),
      };

      // Store refresh token in shared state
      dynamoDBState.refreshTokens.set(tokenBody.refresh_token, {
        token: tokenBody.refresh_token,
        userId: 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      const refreshResult = await refreshHandler(refreshEvent as APIGatewayProxyEvent);
      expect(refreshResult.statusCode).toBe(200);
      const refreshBody = JSON.parse(refreshResult.body);
      expect(refreshBody.access_token).toBeDefined();
      expect(refreshBody.refresh_token).toBeDefined();

      // Step 5: Revoke token
      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/revoke',
        httpMethod: 'POST',
        headers: {
          Authorization: `Bearer ${tokenBody.access_token}`,
        },
        body: JSON.stringify({ refresh_token: refreshBody.refresh_token }),
      };

      const revokeResult = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(revokeResult.statusCode).toBe(200);
      const revokeBody = JSON.parse(revokeResult.body);
      expect(revokeBody.message).toBe('Token revoked successfully');
    });

    it('should fail token request with reused challenge', async () => {
      // Generate challenge
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      const challengeResult = await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      const challengeBody = JSON.parse(challengeResult.body);

      // Setup agent
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      // First token request (should succeed)
      const tokenEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/token',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          challenge: challengeBody.challenge,
          signature: 'valid-signature',
        }),
      };

      const tokenResult1 = await tokenHandler(tokenEvent as APIGatewayProxyEvent);
      expect(tokenResult1.statusCode).toBe(200);

      // Second token request with same challenge (should fail)
      const tokenResult2 = await tokenHandler(tokenEvent as APIGatewayProxyEvent);
      expect(tokenResult2.statusCode).toBe(400);
      const tokenBody2 = JSON.parse(tokenResult2.body);
      expect(tokenBody2.code).toBe('INVALID_CHALLENGE');
    });

    it('should fail refresh with revoked token', async () => {
      // Setup agent
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      // Store revoked refresh token
      const refreshToken = 'revoked-refresh-token';
      dynamoDBState.refreshTokens.set(refreshToken, {
        token: refreshToken,
        userId: 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: true,
      });

      const refreshEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/refresh',
        httpMethod: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      };

      const refreshResult = await refreshHandler(refreshEvent as APIGatewayProxyEvent);
      expect(refreshResult.statusCode).toBe(401);
      const refreshBody = JSON.parse(refreshResult.body);
      expect(refreshBody.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should fail refresh with expired token', async () => {
      // Setup agent
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      // Store expired refresh token
      const refreshToken = 'expired-refresh-token';
      dynamoDBState.refreshTokens.set(refreshToken, {
        token: refreshToken,
        userId: 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Expired yesterday
        isRevoked: false,
      });

      const refreshEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/refresh',
        httpMethod: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      };

      const refreshResult = await refreshHandler(refreshEvent as APIGatewayProxyEvent);
      expect(refreshResult.statusCode).toBe(401);
      const refreshBody = JSON.parse(refreshResult.body);
      expect(refreshBody.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should fail token request for revoked agent', async () => {
      // Generate challenge
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      const challengeResult = await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      const challengeBody = JSON.parse(challengeResult.body);

      // Setup revoked agent
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'revoked',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
        revokedAt: new Date().toISOString(),
      });

      const tokenEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/token',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          challenge: challengeBody.challenge,
          signature: 'valid-signature',
        }),
      };

      const tokenResult = await tokenHandler(tokenEvent as APIGatewayProxyEvent);
      expect(tokenResult.statusCode).toBe(401);
      const tokenBody = JSON.parse(tokenResult.body);
      expect(tokenBody.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Challenge state management', () => {
    it('should store challenge with correct structure', async () => {
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      await challengeHandler(challengeEvent as APIGatewayProxyEvent);

      const storedItem = dynamoDBState.challenges.get(validDid) as Record<string, unknown>;
      expect(storedItem).toMatchObject({
        did: validDid,
        challenge: expect.any(String),
        createdAt: expect.any(String),
        ttl: expect.any(Number),
      });
    });

    it('should update challenge for same DID', async () => {
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      const firstItem = dynamoDBState.challenges.get(validDid);

      await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      const secondItem = dynamoDBState.challenges.get(validDid);

      expect((firstItem as Record<string, unknown>).challenge).not.toBe(
        (secondItem as Record<string, unknown>).challenge
      );
    });
  });

  describe('Token state management', () => {
    it('should store refresh token with correct structure', async () => {
      // Generate challenge
      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      const challengeResult = await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      const challengeBody = JSON.parse(challengeResult.body);

      // Setup agent
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const tokenEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/token',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          challenge: challengeBody.challenge,
          signature: 'valid-signature',
        }),
      };

      await tokenHandler(tokenEvent as APIGatewayProxyEvent);

      // Check that refresh token was stored
      const tokens = Array.from(dynamoDBState.refreshTokens.values());
      expect(tokens.length).toBeGreaterThan(0);
      const storedToken = tokens[0] as Record<string, unknown>;
      expect(storedToken).toMatchObject({
        userId: 'test-user-id',
        did: validDid,
        isRevoked: false,
      });
    });
  });

  describe('Revoke state management', () => {
    it('should add JTI to blacklist on revoke', async () => {
      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/revoke',
        httpMethod: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
        body: JSON.stringify({}),
      };

      const revokeResult = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(revokeResult.statusCode).toBe(200);

      // Verify JTI was added to blacklist
      const blacklistedItems = Array.from(dynamoDBState.tokenBlacklist.values());
      expect(blacklistedItems.length).toBeGreaterThan(0);
      const blacklistedItem = blacklistedItems[0] as Record<string, unknown>;
      expect(blacklistedItem.jti).toBeDefined();
      expect(blacklistedItem.did).toBe(validDid);
    });

    it('should delete refresh token on revoke when provided', async () => {
      const refreshToken = 'refresh-token-to-delete';
      dynamoDBState.refreshTokens.set(refreshToken, {
        token: refreshToken,
        userId: 'test-user-id',
        did: validDid,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        isRevoked: false,
      });

      const revokeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/revoke',
        httpMethod: 'POST',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      };

      const revokeResult = await revokeHandler(revokeEvent as APIGatewayProxyEvent);
      expect(revokeResult.statusCode).toBe(200);

      // Verify refresh token was deleted
      expect(dynamoDBState.refreshTokens.has(refreshToken)).toBe(false);
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors in challenge handler', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB Error'));

      const challengeEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/challenge',
        httpMethod: 'POST',
        body: JSON.stringify({ did: validDid }),
      };

      const result = await challengeHandler(challengeEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });

    it('should handle DynamoDB errors in token handler', async () => {
      dynamoDBState.agents.set(validDid, {
        userId: 'test-user-id',
        did: validDid,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      dynamoDBState.challenges.set(validDid, {
        did: validDid,
        challenge: 'test-challenge',
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      mockSend.mockRejectedValueOnce(new Error('DynamoDB Error'));

      const tokenEvent: Partial<APIGatewayProxyEvent> = {
        path: '/auth/token',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          challenge: 'test-challenge',
          signature: 'valid-signature',
        }),
      };

      const result = await tokenHandler(tokenEvent as APIGatewayProxyEvent);
      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
