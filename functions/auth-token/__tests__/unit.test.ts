process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.JWT_PRIVATE_KEY = 'test-private-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';

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

describe('auth-token handler', () => {
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

    mockSend.mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /auth/token', async () => {
      mockSend
        .mockResolvedValueOnce({
          Item: {
            did: validBody.did,
            challenge: validBody.challenge,
            createdAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 600,
          },
        })
        .mockResolvedValueOnce({}) // delete challenge
        .mockResolvedValueOnce({
          Items: [
            {
              userId: 'test-user-id',
              did: validBody.did,
              status: 'active',
            },
          ],
        })
        .mockResolvedValueOnce({}); // store refresh token

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBeDefined();
      expect(body.token_type).toBe('Bearer');
    });

    it('should return 404 for unknown routes', async () => {
      mockEvent.path = '/auth/unknown';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('Request validation', () => {
    it('should return 400 for invalid request body', async () => {
      mockEvent.body = 'not-json';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_BODY');
    });

    it('should return 400 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({ did: 'test-did' });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });
  });

  describe('DID validation', () => {
    it('should return 400 for invalid DID format', async () => {
      mockEvent.body = JSON.stringify({
        did: 'invalid-did',
        challenge: 'test-challenge',
        signature: 'test-sig',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });
  });

  describe('Challenge validation', () => {
    it('should return 401 for non-existent challenge', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });

    it('should return 401 for mismatched challenge', async () => {
      mockSend.mockResolvedValueOnce({
        Item: {
          did: validBody.did,
          challenge: 'different-challenge',
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 600,
        },
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });
  });

  describe('Signature validation', () => {
    it('should return 401 for invalid signature', async () => {
      const { verifySignature } = await import('@ainx/crypto-utils');
      (verifySignature as jest.Mock).mockReturnValueOnce(false);

      mockSend.mockResolvedValueOnce({
        Item: {
          did: validBody.did,
          challenge: validBody.challenge,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 600,
        },
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Error handling', () => {
    it('should return 500 on DynamoDB error', async () => {
      mockSend.mockRejectedValueOnce(new Error('DB Error'));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
