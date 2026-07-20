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
  generateId: jest.fn(),
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
const dynamoDBState = new Map<string, unknown>();

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn((params: { Item: { did: string }; ConditionExpression: string }) => ({
        promise: jest.fn().mockImplementation(() => {
          const { did } = params.Item;
          if (
            dynamoDBState.has(did) &&
            params.ConditionExpression?.includes('attribute_not_exists')
          ) {
            const error = new Error('The conditional request failed');
            (error as Error & { name: string }).name = 'ConditionalCheckFailedException';
            return Promise.reject(error);
          }
          dynamoDBState.set(did, params.Item);
          return Promise.resolve({});
        }),
      })),
    })),
  },
}));

describe('Integration: agent-registration handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    signature: 'dGVzdHNpZ25hdHVyZQ==',
    metadata: { name: 'Test Agent' },
  };

  beforeEach(() => {
    mockEvent = {
      path: '/agents/register',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
    dynamoDBState.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should handle full registration flow', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Agent registered successfully');
    expect(body.did).toBe(validBody.did);
    expect(body.registeredAt).toBeDefined();
    expect(body.ttl).toBeDefined();

    // Verify item was stored in mock DynamoDB
    expect(dynamoDBState.has(validBody.did)).toBe(true);
    const storedItem = dynamoDBState.get(validBody.did) as Record<string, unknown>;
    expect(storedItem.did).toBe(validBody.did);
    expect(storedItem.signature).toBe(validBody.signature);
    expect(storedItem.metadata).toEqual(validBody.metadata);
    expect(storedItem.ttl).toBeDefined();
  });

  it('should prevent duplicate registration with atomic check', async () => {
    // First registration
    const firstResult = await handler(mockEvent as APIGatewayProxyEvent);
    expect(firstResult.statusCode).toBe(201);

    // Second registration with same DID
    const secondResult = await handler(mockEvent as APIGatewayProxyEvent);
    expect(secondResult.statusCode).toBe(409);
    const body = JSON.parse(secondResult.body);
    expect(body.code).toBe('DUPLICATE_DID');

    // Verify only one item exists
    expect(dynamoDBState.size).toBe(1);
  });

  it('should handle concurrent registration attempts', async () => {
    const requests = Array.from({ length: 5 }, () => handler(mockEvent as APIGatewayProxyEvent));

    const results = await Promise.all(requests);

    // Only one should succeed, rest should get 409
    const successCount = results.filter((r) => r.statusCode === 201).length;
    const conflictCount = results.filter((r) => r.statusCode === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(4);
    expect(dynamoDBState.size).toBe(1);
  });

  it('should store TTL approximately 90 days from now', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);
    expect(result.statusCode).toBe(201);

    const storedItem = dynamoDBState.get(validBody.did) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);
    const expectedTtl = now + 90 * 24 * 60 * 60;
    expect(storedItem.ttl).toBeGreaterThanOrEqual(expectedTtl - 5);
    expect(storedItem.ttl).toBeLessThanOrEqual(expectedTtl + 5);
  });
});
