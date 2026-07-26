process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';

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

// Track DynamoDB state for integration tests
const dynamoDBState = new Map<string, unknown>();

const mockPutFn = jest.fn((params: { Item: { did: string; challenge: string } }) => ({
  promise: jest.fn().mockImplementation(() => {
    const { did } = params.Item;
    dynamoDBState.set(did, params.Item);
    return Promise.resolve({});
  }),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (_params: unknown) => mockPutFn(_params as { Item: { did: string; challenge: string } }),
    })),
  },
}));

describe('Integration: auth-challenge handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;
  const validBody = {
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
  };

  beforeEach(() => {
    mockEvent = {
      path: '/auth/challenge',
      httpMethod: 'POST',
      body: JSON.stringify(validBody),
    };
    process.env.CHALLENGE_TABLE_NAME = 'test-challenge-table';
    dynamoDBState.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full challenge flow', () => {
    it('should handle complete challenge generation flow', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.challenge).toBeDefined();
      expect(body.expires_at).toBeDefined();

      // Verify challenge stored in DynamoDB
      const storedItem = dynamoDBState.get(validBody.did);
      expect(storedItem).toBeDefined();
      expect((storedItem as Record<string, unknown>).challenge).toBe(body.challenge);
      expect((storedItem as Record<string, unknown>).ttl).toBeDefined();
    });

    it('should generate different challenges for same DID', async () => {
      const result1 = await handler(mockEvent as APIGatewayProxyEvent);
      const result2 = await handler(mockEvent as APIGatewayProxyEvent);

      const body1 = JSON.parse(result1.body);
      const body2 = JSON.parse(result2.body);

      expect(body1.challenge).not.toBe(body2.challenge);
    });

    it('should update challenge for same DID', async () => {
      await handler(mockEvent as APIGatewayProxyEvent);
      const firstItem = dynamoDBState.get(validBody.did);

      await handler(mockEvent as APIGatewayProxyEvent);
      const secondItem = dynamoDBState.get(validBody.did);

      expect((firstItem as Record<string, unknown>).challenge).not.toBe(
        (secondItem as Record<string, unknown>).challenge
      );
    });
  });

  describe('DynamoDB state management', () => {
    it('should store challenge with correct TTL', async () => {
      const beforeRequest = Math.floor(Date.now() / 1000);
      await handler(mockEvent as APIGatewayProxyEvent);
      const afterRequest = Math.floor(Date.now() / 1000);

      const storedItem = dynamoDBState.get(validBody.did) as Record<string, unknown>;
      const ttl = storedItem.ttl as number;

      expect(ttl).toBeGreaterThan(beforeRequest + 240); // ~4 minutes
      expect(ttl).toBeLessThan(afterRequest + 360); // ~6 minutes
    });

    it('should store challenge with correct structure', async () => {
      await handler(mockEvent as APIGatewayProxyEvent);

      const storedItem = dynamoDBState.get(validBody.did) as Record<string, unknown>;
      expect(storedItem).toMatchObject({
        did: validBody.did,
        challenge: expect.any(String),
        createdAt: expect.any(String),
        ttl: expect.any(Number),
      });
    });
  });

  describe('Error scenarios', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockPutFn.mockImplementationOnce(() => ({
        promise: jest.fn().mockRejectedValue(new Error('DynamoDB Error')),
      }));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
