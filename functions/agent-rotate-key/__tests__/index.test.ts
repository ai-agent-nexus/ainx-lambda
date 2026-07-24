process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';
import { verifySignature } from '@ainx/crypto-utils';

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

const mockPutFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({}),
}));

const mockQueryFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({ Items: [] }),
}));

const mockTransactWriteFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (_params: unknown) => (mockPutFn as jest.Mock)(_params),
      query: (_params: unknown) => (mockQueryFn as jest.Mock)(_params),
      transactWrite: (_params: unknown) => (mockTransactWriteFn as jest.Mock)(_params),
    })),
  },
}));

describe('agent-rotate-key handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    oldDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    newDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY',
    signature: 'dGVzdHNpZ25hdHVyZQ==',
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'test-nonce-123',
  };

  beforeEach(async () => {
    mockEvent = {
      path: '/agents/rotate-key',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
    process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness';
    process.env.NONCE_TABLE_NAME = 'test-nonce-table';

    mockPutFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
    mockQueryFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({ Items: [] }),
    }));
    mockTransactWriteFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));

    const { parseDidKey } = await import('@ainx/did-utils');
    (parseDidKey as jest.Mock).mockReset();
    (parseDidKey as jest.Mock).mockImplementation((did: string) => {
      if (!did || !did.startsWith('did:key:')) {
        throw new Error('Invalid DID format');
      }
      return {
        method: 'key',
        publicKey: Buffer.from('a'.repeat(32)),
        keyType: 'ed25519',
      };
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      mockEvent.body = JSON.stringify({ oldDid: 'test-did' });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });

    it('should return 400 for expired timestamp', async () => {
      mockEvent.body = JSON.stringify({
        ...validBody,
        timestamp: Math.floor(Date.now() / 1000) - 400,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('TIMESTAMP_EXPIRED');
    });
  });

  describe('Nonce validation', () => {
    it('should return 400 for reused nonce', async () => {
      mockPutFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue({
          name: 'ConditionalCheckFailedException',
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('REUSED_NONCE');
    });
  });

  describe('DID validation', () => {
    it('should return 400 for invalid old DID format', async () => {
      mockEvent.body = JSON.stringify({
        ...validBody,
        oldDid: 'invalid-did',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });

    it('should return 400 for invalid new DID format', async () => {
      const { parseDidKey } = await import('@ainx/did-utils');
      (parseDidKey as jest.Mock).mockImplementationOnce(() => ({
        method: 'key',
        publicKey: Buffer.from('a'.repeat(32)),
        keyType: 'ed25519',
      }));
      (parseDidKey as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Invalid DID format');
      });

      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              userId: 'test-user-id',
              did: validBody.oldDid,
              status: 'active',
              metadata: { name: 'Test Agent' },
              didHistory: [],
              registeredAt: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      }));

      mockEvent.body = JSON.stringify({
        ...validBody,
        newDid: 'invalid-did',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });
  });

  describe('Signature validation', () => {
    it('should return 400 for invalid signature', async () => {
      (verifySignature as jest.Mock).mockReturnValueOnce(false);

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });

    it('should return 400 for signature verification error', async () => {
      (verifySignature as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Verification failed');
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Old DID status check', () => {
    it('should return 400 for revoked old DID', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_REVOKED');
    });
  });

  describe('New DID uniqueness check', () => {
    it('should return 409 for duplicate new DID', async () => {
      mockQueryFn.mockImplementation((params: unknown) => {
        const p = params as { ExpressionAttributeValues?: { ':did'?: string } };
        if (p.ExpressionAttributeValues?.[':did'] === validBody.newDid) {
          return {
            promise: jest.fn().mockResolvedValue({
              Items: [{ did: validBody.newDid }],
            }),
          };
        }
        return {
          promise: jest.fn().mockResolvedValue({
            Items: [
              {
                userId: 'test-user-id',
                did: validBody.oldDid,
                status: 'active',
                metadata: { name: 'Test Agent' },
                didHistory: [],
                registeredAt: '2024-01-01T00:00:00Z',
              },
            ],
          }),
        };
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DUPLICATE_DID');
    });
  });

  describe('Successful rotation', () => {
    it('should return 200 on successful key rotation', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              userId: 'test-user-id',
              did: validBody.oldDid,
              status: 'active',
              metadata: { name: 'Test Agent' },
              didHistory: [],
              registeredAt: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Key rotated successfully');
      expect(body.did).toBe(validBody.newDid);
      expect(body.updatedAt).toBeDefined();
    });

    it('should perform transactWrite with correct items', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              userId: 'test-user-id',
              did: validBody.oldDid,
              status: 'active',
              metadata: { name: 'Test Agent' },
              didHistory: [],
              registeredAt: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      }));

      await handler(mockEvent as APIGatewayProxyEvent);

      expect(mockTransactWriteFn).toHaveBeenCalled();
      const callArgs = (mockTransactWriteFn as jest.Mock).mock.calls[0][0];
      expect(callArgs!.TransactItems).toHaveLength(3);
      expect(callArgs!.TransactItems[0].Put.TableName).toBe('test-did-uniqueness');
      expect(callArgs!.TransactItems[1].Put.TableName).toBe('test-table');
      expect(callArgs!.TransactItems[2].Update.TableName).toBe('test-table');
    });
  });

  describe('Error handling', () => {
    it('should return 409 on concurrent modification', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [
            {
              userId: 'test-user-id',
              did: validBody.oldDid,
              status: 'active',
              metadata: { name: 'Test Agent' },
              didHistory: [],
              registeredAt: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      }));

      mockTransactWriteFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue({
          name: 'TransactionCanceledException',
        }),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('CONCURRENT_MODIFICATION');
    });

    it('should return 500 on unexpected error', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
