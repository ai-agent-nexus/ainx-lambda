process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';

import { APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import { handler } from '../src/index';

jest.mock('@ainx/logger');

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

const mockQueryFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({
    Items: [
      {
        userId: 'test-user-id',
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        status: 'active',
      },
    ],
  }),
})) as jest.Mock;

const mockGetFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({
    Item: undefined,
  }),
})) as jest.Mock;

const mockPutFn = jest.fn((_params: unknown) => ({
  promise: jest.fn().mockResolvedValue({}),
})) as jest.Mock;

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (_params: unknown) => (mockQueryFn as jest.Mock)(_params),
      get: (_params: unknown) => (mockGetFn as jest.Mock)(_params),
      put: (_params: unknown) => (mockPutFn as jest.Mock)(_params),
    })),
  },
}));

describe('auth handler', () => {
  let mockEvent: Partial<APIGatewayTokenAuthorizerEvent>;
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';
  const validSignature = 'dGVzdHNpZ25hdHVyZQ==';
  const validTimestamp = Math.floor(Date.now() / 1000);
  const validNonce = 'test-nonce-123';
  const validToken = `${validDid}:${validSignature}:${validTimestamp}:${validNonce}`;

  beforeEach(() => {
    mockEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abc123/sit/POST/agents/rotate-key',
      authorizationToken: validToken,
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
    process.env.NONCE_TABLE_NAME = 'test-nonce-table';
    mockQueryFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({
        Items: [
          {
            userId: 'test-user-id',
            did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
            status: 'active',
          },
        ],
      }),
    }));
    mockGetFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({
        Item: undefined,
      }),
    }));
    mockPutFn.mockImplementation(() => ({
      promise: jest.fn().mockResolvedValue({}),
    }));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Token validation', () => {
    it('should return deny policy for missing token', async () => {
      mockEvent.authorizationToken = undefined;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for invalid token format (missing parts)', async () => {
      mockEvent.authorizationToken = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for invalid token format (wrong prefix)', async () => {
      mockEvent.authorizationToken = 'invalid-token-format';

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for invalid timestamp', async () => {
      mockEvent.authorizationToken = `${validDid}:${validSignature}:invalid:${validNonce}`;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for expired timestamp', async () => {
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
      mockEvent.authorizationToken = `${validDid}:${validSignature}:${expiredTimestamp}:${validNonce}`;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for reused nonce', async () => {
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Item: { nonce: validNonce },
        }),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('DID validation', () => {
    it('should return deny policy for invalid DID format', async () => {
      mockEvent.authorizationToken = `invalid-did:${validSignature}:${validTimestamp}:${validNonce}`;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('Signature validation', () => {
    it('should return deny policy for invalid signature', async () => {
      const { verifySignature } = await import('@ainx/crypto-utils');
      (verifySignature as jest.Mock).mockReturnValueOnce(false);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for signature verification error', async () => {
      const { verifySignature } = await import('@ainx/crypto-utils');
      (verifySignature as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Verification failed');
      });

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('DID status check', () => {
    it('should return deny policy for revoked DID', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('Successful authentication', () => {
    it('should return allow policy with context for valid token', async () => {
      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe(validDid);
      expect(result.policyDocument.Statement[0]).toEqual(
        expect.objectContaining({
          Effect: 'Allow',
        })
      );
      expect(result.policyDocument.Statement[0]).toEqual(
        expect.objectContaining({
          Effect: 'Allow',
          Resource: mockEvent.methodArn,
        })
      );
      expect(result.context).toEqual({
        did: validDid,
        userId: 'test-user-id',
      });
    });

    it('should query DynamoDB with correct parameters', async () => {
      await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(mockQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-table',
          IndexName: 'DidIndex',
          KeyConditionExpression: 'did = :did',
          FilterExpression: 'status = :status',
          ExpressionAttributeValues: {
            ':did': validDid,
            ':status': 'active',
          },
        })
      );
    });

    it('should store nonce in NonceTable with TTL', async () => {
      await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(mockPutFn).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'test-nonce-table',
          Item: expect.objectContaining({
            nonce: validNonce,
            ttl: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should return deny policy on DynamoDB query error', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy on nonce validation error', async () => {
      mockGetFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('Nonce DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
