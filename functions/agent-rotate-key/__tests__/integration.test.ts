process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';

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

// Track DynamoDB state for integration tests
const dynamoDBState = {
  agents: new Map<string, Array<Record<string, unknown>>>(),
  uniqueness: new Map<string, unknown>(),
  nonces: new Set<string>(),
};

const mockPutFn = jest.fn((_params: unknown) => {
  const params = _params as {
    TableName: string;
    Item: Record<string, unknown>;
    ConditionExpression?: string;
  };
  const tableName = params.TableName;
  const item = params.Item;

  if (tableName.includes('uniqueness')) {
    const did = item.did as string;
    if (dynamoDBState.uniqueness.has(did)) {
      const error = new Error('Conditional check failed');
      (error as Error & { name: string }).name = 'ConditionalCheckFailedException';
      return { promise: jest.fn().mockRejectedValue(error) };
    }
    dynamoDBState.uniqueness.set(did, item);
    return { promise: jest.fn().mockResolvedValue({}) };
  }

  if (tableName.includes('nonce')) {
    const nonce = item.nonce as string;
    if (dynamoDBState.nonces.has(nonce)) {
      const error = new Error('Conditional check failed');
      (error as Error & { name: string }).name = 'ConditionalCheckFailedException';
      return { promise: jest.fn().mockRejectedValue(error) };
    }
    dynamoDBState.nonces.add(nonce);
    return { promise: jest.fn().mockResolvedValue({}) };
  }

  const did = item.did as string;
  const existing = dynamoDBState.agents.get(did) || [];
  existing.push(item);
  dynamoDBState.agents.set(did, existing);
  return { promise: jest.fn().mockResolvedValue({}) };
});

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
  const items = dynamoDBState.agents.get(did) || [];
  const filteredItems = status ? items.filter((item) => item.status === status) : items;

  return {
    promise: jest.fn().mockResolvedValue({ Items: filteredItems }),
  };
});

const mockTransactWriteFn = jest.fn((_params: unknown) => {
  const params = _params as { TransactItems: Array<Record<string, unknown>> };
  const items = params.TransactItems;

  try {
    for (const item of items) {
      const put = (item as { Put?: { TableName: string; Item: Record<string, unknown> } }).Put;
      const update = (item as { Update?: { TableName: string; Key: Record<string, unknown> } })
        .Update;

      if (put) {
        const tableName = put.TableName;
        const itemData = put.Item;
        if (tableName.includes('uniqueness')) {
          const did = itemData.did as string;
          if (dynamoDBState.uniqueness.has(did)) {
            const error = new Error('Transaction cancelled');
            (error as Error & { name: string }).name = 'TransactionCanceledException';
            throw error;
          }
          dynamoDBState.uniqueness.set(did, itemData);
        } else {
          const did = itemData.did as string;
          const existing = dynamoDBState.agents.get(did) || [];
          existing.push(itemData);
          dynamoDBState.agents.set(did, existing);
        }
      }

      if (update) {
        const key = update.Key;
        const did = key.did as string;
        const userId = key.userId as string;
        const existing = dynamoDBState.agents.get(did) || [];
        const itemIndex = existing.findIndex((i) => i.userId === userId);
        if (itemIndex >= 0) {
          existing[itemIndex] = { ...existing[itemIndex], status: 'revoked' };
        }
      }
    }
    return { promise: jest.fn().mockResolvedValue({}) };
  } catch (error) {
    return { promise: jest.fn().mockRejectedValue(error) };
  }
});

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (_params: unknown) => mockPutFn(_params),
      query: (_params: unknown) => mockQueryFn(_params),
      transactWrite: (_params: unknown) => mockTransactWriteFn(_params),
    })),
  },
}));

describe('Integration: agent-rotate-key handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    oldDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    newDid: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CY',
    signature: 'dGVzdHNpZ25hdHVyZQ==',
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'test-nonce-123',
  };

  beforeEach(() => {
    mockEvent = {
      path: '/agents/rotate-key',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
    process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness';
    process.env.NONCE_TABLE_NAME = 'test-nonce-table';

    dynamoDBState.agents.clear();
    dynamoDBState.uniqueness.clear();
    dynamoDBState.nonces.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full rotation flow', () => {
    it('should handle complete key rotation', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Key rotated successfully');
      expect(body.did).toBe(validBody.newDid);

      // Verify old DID is revoked
      const oldDidItems = dynamoDBState.agents.get(validBody.oldDid) || [];
      const revokedItem = oldDidItems.find((item) => item.status === 'revoked');
      expect(revokedItem).toBeDefined();

      // Verify new DID is registered
      const newDidItems = dynamoDBState.agents.get(validBody.newDid) || [];
      const activeItem = newDidItems.find((item) => item.status === 'active');
      expect(activeItem).toBeDefined();
      expect(activeItem?.userId).toBe('test-user-id');

      // Verify uniqueness table
      expect(dynamoDBState.uniqueness.has(validBody.newDid)).toBe(true);
    });

    it('should prevent rotation with reused nonce', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // First rotation
      const firstResult = await handler(mockEvent as APIGatewayProxyEvent);
      expect(firstResult.statusCode).toBe(200);

      // Second rotation with same nonce
      const secondResult = await handler(mockEvent as APIGatewayProxyEvent);
      expect(secondResult.statusCode).toBe(400);
      const body = JSON.parse(secondResult.body);
      expect(body.code).toBe('REUSED_NONCE');
    });

    it('should prevent rotation to existing DID', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Setup: Register new DID (already exists)
      dynamoDBState.agents.set(validBody.newDid, [
        {
          userId: 'another-user-id',
          did: validBody.newDid,
          status: 'active',
          metadata: { name: 'Another Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);
      dynamoDBState.uniqueness.set(validBody.newDid, {
        did: validBody.newDid,
        userId: 'another-user-id',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DUPLICATE_DID');
    });

    it('should handle concurrent rotations', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const anotherNewDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CX';

      // First rotation
      const firstResult = await handler(mockEvent as APIGatewayProxyEvent);
      expect(firstResult.statusCode).toBe(200);

      // Try to rotate again (old DID is now revoked)
      const secondEvent = {
        ...mockEvent,
        body: JSON.stringify({
          ...validBody,
          newDid: anotherNewDid,
          nonce: 'another-nonce-456',
        }),
      };

      const secondResult = await handler(secondEvent as APIGatewayProxyEvent);
      expect(secondResult.statusCode).toBe(400);
      const body = JSON.parse(secondResult.body);
      expect(body.code).toBe('DID_REVOKED');
    });
  });

  describe('DynamoDB state management', () => {
    it('should maintain didHistory across rotations', async () => {
      // Setup: Register old DID with history
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [{ did: 'did:key:original', revokedAt: null, reason: null }],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);

      // Verify new DID has updated history
      const newDidItems = dynamoDBState.agents.get(validBody.newDid) || [];
      const activeItem = newDidItems.find((item) => item.status === 'active');
      expect(activeItem).toBeDefined();
      expect(activeItem?.didHistory).toHaveLength(2);
    });

    it('should preserve metadata during rotation', async () => {
      const metadata = { name: 'Test Agent', version: '1.0' };

      // Setup: Register old DID with metadata
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata,
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);

      // Verify new DID has same metadata
      const newDidItems = dynamoDBState.agents.get(validBody.newDid) || [];
      const activeItem = newDidItems.find((item) => item.status === 'active');
      expect(activeItem?.metadata).toEqual(metadata);
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB transaction failure', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      // Simulate transaction failure by making transactWrite throw
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

    it('should handle unexpected DynamoDB errors', async () => {
      // Setup: Register old DID
      dynamoDBState.agents.set(validBody.oldDid, [
        {
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
          metadata: { name: 'Test Agent' },
          didHistory: [],
          registeredAt: '2024-01-01T00:00:00Z',
        },
      ]);

      mockTransactWriteFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('Unexpected DB error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
