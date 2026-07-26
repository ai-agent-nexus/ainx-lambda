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

const mockGetFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Item: undefined }),
}));

const mockPutFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

const mockDeleteFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (...args: unknown[]) => (mockGetFn as jest.Mock)(...args),
      put: (...args: unknown[]) => (mockPutFn as jest.Mock)(...args),
      delete: (...args: unknown[]) => (mockDeleteFn as jest.Mock)(...args),
    })),
  },
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

    mockGetFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Item: undefined }),
    }));
    mockPutFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
    mockDeleteFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Routing', () => {
    it('should handle POST /auth/token', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: validBody.did,
                status: 'active',
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

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

  describe('Signature validation', () => {
    it('should return 401 for invalid signature', async () => {
      const { verifySignature } = await import('@ainx/crypto-utils');
      (verifySignature as jest.Mock).mockReturnValueOnce(false);

      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Challenge validation', () => {
    it('should return 400 for invalid challenge', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: 'different-challenge' },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });

    it('should return 400 for expired challenge', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({ Item: undefined }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_CHALLENGE');
    });
  });

  describe('DID status check', () => {
    it('should return 401 for revoked DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: validBody.did,
                status: 'revoked',
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });

    it('should return 401 for non-existent DID', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_NOT_FOUND');
    });
  });

  describe('Token generation', () => {
    it('should generate valid token pair', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: validBody.did,
                status: 'active',
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.access_token).toBe('mock-jwt-token');
      expect(body.refresh_token).toBeDefined();
      expect(body.expires_in).toBe(3600);
      expect(body.token_type).toBe('Bearer');
    });

    it('should store refresh token in DynamoDB', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: validBody.did,
                status: 'active',
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(mockPutFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-refresh-token-table',
          Item: expect.objectContaining({
            token: expect.any(String),
            userId: 'test-user-id',
            did: validBody.did,
            isRevoked: false,
          }),
        })
      );
    });

    it('should delete challenge after use', async () => {
      mockGetFn.mockImplementation((params: unknown) => {
        const p = params as { TableName: string; Key: Record<string, unknown> };
        if (p.TableName === 'test-challenge-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: { did: validBody.did, challenge: validBody.challenge },
            }),
          };
        }
        if (p.TableName === 'test-agent-registration-table') {
          return {
            promise: jest.fn().mockResolvedValue({
              Item: {
                userId: 'test-user-id',
                did: validBody.did,
                status: 'active',
              },
            }),
          };
        }
        return { promise: jest.fn().mockResolvedValue({ Item: undefined }) };
      });

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(mockDeleteFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-challenge-table',
          Key: { did: validBody.did },
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return 500 on DynamoDB error', async () => {
      mockGetFn.mockImplementation(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
