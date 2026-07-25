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

// Track DynamoDB state for integration tests
const dynamoDBState = new Map<string, Array<Record<string, unknown>>>();
const nonceState = new Set<string>();

const mockQueryFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    IndexName: string;
    KeyConditionExpression: string;
    FilterExpression?: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
  const did = params.ExpressionAttributeValues[':did'] as string;
  const status = params.ExpressionAttributeValues[':status'] as string;
  const items = dynamoDBState.get(did) || [];
  const filteredItems = status ? items.filter((item) => item.status === status) : items;

  return {
    promise: jest.fn().mockResolvedValue({ Items: filteredItems }),
  };
});

const mockGetFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    Key: { nonce: string };
  };
  const nonce = params.Key.nonce;
  const exists = nonceState.has(nonce);

  return {
    promise: jest.fn().mockResolvedValue({ Item: exists ? { nonce } : undefined }),
  };
});

const mockPutFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    Item: { nonce: string };
  };
  nonceState.add(params.Item.nonce);

  return {
    promise: jest.fn().mockResolvedValue({}),
  };
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (_params: unknown) => mockQueryFn(_params),
      get: (_params: unknown) => mockGetFn(_params),
      put: (_params: unknown) => mockPutFn(_params),
    })),
  },
}));

describe('Integration: auth handler', () => {
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
    dynamoDBState.clear();
    nonceState.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication flow', () => {
    it('should authenticate valid token with active DID', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe(validDid);
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
      expect(result.context).toEqual({
        did: validDid,
        userId: 'test-user-id',
      });
    });

    it('should deny authentication for revoked DID', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'revoked',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should deny authentication for non-existent DID', async () => {
      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe('unauthorized');
      expect(result.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should handle multiple DIDs with same prefix', async () => {
      const anotherDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY';
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id-1',
          did: validDid,
          status: 'active',
        },
      ]);
      dynamoDBState.set(anotherDid, [
        {
          userId: 'test-user-id-2',
          did: anotherDid,
          status: 'active',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe(validDid);
      expect(result.context).toEqual({
        did: validDid,
        userId: 'test-user-id-1',
      });
    });
  });

  describe('Nonce validation', () => {
    it('should reject reused nonce', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

      // First call should succeed
      const result1 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result1.principalId).toBe(validDid);

      // Second call with same nonce should fail
      const result2 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result2.principalId).toBe('unauthorized');
      expect(result2.policyDocument.Statement[0].Effect).toBe('Deny');
    });

    it('should allow different nonces for same DID', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

      // First call
      const result1 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result1.principalId).toBe(validDid);

      // Second call with different nonce
      const newNonce = 'different-nonce-456';
      const newToken = `${validDid}:${validSignature}:${validTimestamp}:${newNonce}`;
      mockEvent.authorizationToken = newToken;

      const result2 = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);
      expect(result2.principalId).toBe(validDid);
    });
  });

  describe('Token validation edge cases', () => {
    it('should handle token with colon in DID', async () => {
      const didWithColon = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';
      const token = `${didWithColon}:${validSignature}:${validTimestamp}:${validNonce}`;
      mockEvent.authorizationToken = token;

      dynamoDBState.set(didWithColon, [
        {
          userId: 'test-user-id',
          did: didWithColon,
          status: 'active',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe(didWithColon);
      expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
    });

    it('should handle concurrent authentication requests', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

      // Use different nonces for concurrent requests
      const promises = Array.from({ length: 5 }, (_, i) => {
        const nonce = `concurrent-nonce-${i}`;
        const token = `${validDid}:${validSignature}:${validTimestamp}:${nonce}`;
        const event = { ...mockEvent, authorizationToken: token };
        return handler(event as APIGatewayTokenAuthorizerEvent);
      });

      const results = await Promise.all(promises);

      results.forEach((result) => {
        expect(result.principalId).toBe(validDid);
        expect(result.policyDocument.Statement[0].Effect).toBe('Allow');
      });
    });
  });

  describe('DynamoDB query behavior', () => {
    it('should query with correct parameters', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

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

    it('should filter by active status', async () => {
      dynamoDBState.set(validDid, [
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'revoked',
        },
        {
          userId: 'test-user-id',
          did: validDid,
          status: 'active',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayTokenAuthorizerEvent);

      expect(result.principalId).toBe(validDid);
      expect(result.context).toEqual({
        did: validDid,
        userId: 'test-user-id',
      });
    });
  });
});
