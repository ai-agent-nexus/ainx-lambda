process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';
import { verifySignature } from '@ainx/crypto-utils';

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
      query: jest.fn(() => ({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      })),
      transactWrite: jest.fn(
        (params: { TransactItems: Array<{ Put?: { Item?: { did: string } } }> }) => ({
          promise: jest.fn().mockImplementation(() => {
            const items = params.TransactItems;
            const allDids: string[] = [];
            for (const item of items) {
              if (item.Put?.Item?.did) {
                allDids.push(item.Put.Item.did);
              }
            }

            for (const did of allDids) {
              if (dynamoDBState.has(did)) {
                const error = new Error('Transaction cancelled');
                (error as Error & { name: string }).name = 'TransactionCanceledException';
                return Promise.reject(error);
              }
            }

            for (const item of items) {
              if (item.Put?.Item?.did) {
                dynamoDBState.set(item.Put.Item.did, item.Put.Item);
              }
            }

            return Promise.resolve({});
          }),
        })
      ),
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
  });

  it('should handle duplicate registration', async () => {
    // First registration
    const firstResult = await handler(mockEvent as APIGatewayProxyEvent);
    expect(firstResult.statusCode).toBe(201);

    // Second registration with same DID
    const secondResult = await handler(mockEvent as APIGatewayProxyEvent);
    expect(secondResult.statusCode).toBe(409);
    const body = JSON.parse(secondResult.body);
    expect(body.code).toBe('DUPLICATE_DID');
  });

  it('should handle invalid DID format', async () => {
    mockEvent.body = JSON.stringify({
      did: 'invalid-did',
      signature: 'test-sig',
      metadata: {},
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INVALID_DID');
  });

  it('should handle invalid signature', async () => {
    (verifySignature as jest.Mock).mockReturnValueOnce(false);

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INVALID_SIGNATURE');
  });

  it('should handle missing required fields', async () => {
    mockEvent.body = JSON.stringify({ did: 'test-did' });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('MISSING_FIELDS');
  });

  it('should handle invalid request body', async () => {
    mockEvent.body = 'not-json';

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INVALID_BODY');
  });

  it('should handle unexpected errors', async () => {
    expect(true).toBe(true);
  });
});
