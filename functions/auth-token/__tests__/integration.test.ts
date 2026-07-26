process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.JWT_PRIVATE_KEY = 'test-private-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';

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
  verifySignature: jest.fn(() => true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
}));

// Track DynamoDB state for integration tests
const dynamoDBState = {
  challenges: new Map<string, unknown>(),
  agents: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
};

const mockGetFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('challenge')) {
    const did = key.did as string;
    const item = dynamoDBState.challenges.get(did);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  if (tableName.includes('agent-registration')) {
    const did = key.did as string;
    const item = dynamoDBState.agents.get(did);
    return {
      promise: jest.fn().mockResolvedValue({ Item: item }),
    };
  }

  return {
    promise: jest.fn().mockResolvedValue({ Item: undefined }),
  };
});

const mockPutFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Item: Record<string, unknown> };
  const tableName = params.TableName;
  const item = params.Item;

  if (tableName.includes('refresh-token')) {
    const token = item.token as string;
    dynamoDBState.refreshTokens.set(token, item);
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

const mockDeleteFn = jest.fn((_params: unknown) => {
  const params = _params as { TableName: string; Key: Record<string, unknown> };
  const tableName = params.TableName;
  const key = params.Key;

  if (tableName.includes('challenge')) {
    const did = key.did as string;
    dynamoDBState.challenges.delete(did);
  }

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (_params: unknown) => mockGetFn(_params),
      put: (_params: unknown) => mockPutFn(_params),
      delete: (_params: unknown) => mockDeleteFn(_params),
    })),
  },
}));

describe('Integration: auth-token handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    challenge: 'test-challenge-123',
    signature: 'dGVzdHNpZ25hdHVyZQ==',
  };

  beforeEach(() => {
    mockEvent = {
      path: '/auth/token',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.JWT_PRIVATE_KEY = 'test-private-key';

    dynamoDBState.challenges.clear();
    dynamoDBState.agents.clear();
    dynamoDBState.refreshTokens.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full token flow', () => {
    it('should handle complete token generation flow', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // Setup: Store agent
      dynamoDBState.agents.set(validBody.did, {
        userId: 'test-user-id',
        did: validBody.did,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBe('mock-jwt-token');
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBe(3600);
      expect(body.token_type).toBe('Bearer');

      // Verify challenge deleted
      expect(dynamoDBState.challenges.has(validBody.did)).toBe(false);

      // Verify refresh token stored
      const refreshToken = body.refresh_token;
      expect(dynamoDBState.refreshTokens.has(refreshToken)).toBe(true);
      const storedToken = dynamoDBState.refreshTokens.get(refreshToken) as Record<string, unknown>;
      expect(storedToken.userId).toBe('test-user-id');
      expect(storedToken.did).toBe(validBody.did);
      expect(storedToken.isRevoked).toBe(false);
    });

    it('should fail with invalid challenge', async () => {
      // Setup: Store different challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: 'different-challenge',
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });

    it('should fail with expired challenge', async () => {
      // Setup: No challenge stored
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });

    it('should fail with revoked DID', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // Setup: Store revoked agent
      dynamoDBState.agents.set(validBody.did, {
        userId: 'test-user-id',
        did: validBody.did,
        status: 'revoked',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should fail with non-existent DID', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // No agent stored

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Token storage', () => {
    it('should store refresh token with correct structure', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // Setup: Store agent
      dynamoDBState.agents.set(validBody.did, {
        userId: 'test-user-id',
        did: validBody.did,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      const refreshToken = body.refresh_token;

      const storedToken = dynamoDBState.refreshTokens.get(refreshToken) as Record<string, unknown>;
      expect(storedToken).toMatchObject({
        token: refreshToken,
        userId: 'test-user-id',
        did: validBody.did,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        ttl: expect.any(Number),
        isRevoked: false,
      });
    });

    it('should generate unique refresh tokens', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // Setup: Store agent
      dynamoDBState.agents.set(validBody.did, {
        userId: 'test-user-id',
        did: validBody.did,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      const result1 = await handler(mockEvent as APIGatewayProxyEvent);
      const body1 = JSON.parse(result1.body);

      // Reset challenge for second request
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: 'another-challenge',
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      mockEvent.body = JSON.stringify({
        ...validBody,
        challenge: 'another-challenge',
      });

      const result2 = await handler(mockEvent as APIGatewayProxyEvent);
      const body2 = JSON.parse(result2.body);

      expect(body1.refresh_token).not.toBe(body2.refresh_token);
    });
  });

  describe('Challenge cleanup', () => {
    it('should delete challenge after successful token generation', async () => {
      // Setup: Store challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: validBody.challenge,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      // Setup: Store agent
      dynamoDBState.agents.set(validBody.did, {
        userId: 'test-user-id',
        did: validBody.did,
        status: 'active',
        publicKey: Buffer.from('a'.repeat(32)).toString('base64'),
        metadata: { name: 'Test Agent' },
        didHistory: [],
        registeredAt: new Date().toISOString(),
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(dynamoDBState.challenges.has(validBody.did)).toBe(false);
    });

    it('should not delete challenge on failed validation', async () => {
      // Setup: Store different challenge
      dynamoDBState.challenges.set(validBody.did, {
        did: validBody.did,
        challenge: 'different-challenge',
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 300,
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(dynamoDBState.challenges.has(validBody.did)).toBe(true);
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
