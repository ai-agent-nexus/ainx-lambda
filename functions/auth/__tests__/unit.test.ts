process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';

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

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (_params: unknown) => (mockQueryFn as jest.Mock)(_params),
    })),
  },
}));

describe('auth handler', () => {
  let mockEvent: Partial<APIGatewayTokenAuthorizerEvent>;
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';
  const validSignature = 'dGVzdHNpZ25hdHVyZQ==';
  const validTimestamp = Math.floor(Date.now() / 1000);
  const validToken = `${validDid}:${validSignature}:${validTimestamp}`;

  beforeEach(() => {
    mockEvent = {
      type: 'TOKEN',
      methodArn: 'arn:aws:execute-api:us-east-1:123456789012:abc123/sit/POST/agents/rotate-key',
      authorizationToken: validToken,
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
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

    it('should return deny policy for invalid token format', async () => {
      mockEvent.authorizationToken = 'invalid-token';

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for invalid timestamp', async () => {
      mockEvent.authorizationToken = `${validDid}:${validSignature}:invalid`;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should return deny policy for expired timestamp', async () => {
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 400;
      mockEvent.authorizationToken = `${validDid}:${validSignature}:${expiredTimestamp}`;

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });

  describe('DID validation', () => {
    it('should return deny policy for invalid DID format', async () => {
      mockEvent.authorizationToken = `invalid-did:${validSignature}:${validTimestamp}`;

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
  });

  describe('Error handling', () => {
    it('should return deny policy on unexpected error', async () => {
      mockQueryFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });
  });
});
