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

// Track DynamoDB state for integration tests
const dynamoDBState = new Map<string, Array<Record<string, unknown>>>();

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

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (_params: unknown) => mockQueryFn(_params),
    })),
  },
}));

describe('Integration: auth handler', () => {
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
    dynamoDBState.clear();
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

  describe('Token validation edge cases', () => {
    it('should handle token with colon in DID', async () => {
      const didWithColon = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';
      const token = `${didWithColon}:${validSignature}:${validTimestamp}`;
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

      const promises = Array.from({ length: 5 }, () =>
        handler(mockEvent as APIGatewayTokenAuthorizerEvent)
      );

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
