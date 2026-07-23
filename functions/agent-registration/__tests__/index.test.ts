process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';

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

const mockPutFn = jest.fn(() => ({
  promise: jest.fn().mockResolvedValue({}),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (...args: unknown[]) => (mockPutFn as jest.Mock)(...args),
    })),
  },
}));

describe('agent-registration handler', () => {
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
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 201 on successful registration', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('Agent registered successfully');
    expect(body.did).toBe(validBody.did);
    expect(body.registeredAt).toBeDefined();
    expect(body.ttl).toBeDefined();
  });

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
      signature: 'test-sig',
      metadata: {},
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INVALID_DID');
  });

  it('should return 400 for invalid signature', async () => {
    (verifySignature as jest.Mock).mockReturnValueOnce(false);

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INVALID_SIGNATURE');
  });

  it('should return 409 for duplicate DID', async () => {
    mockPutFn.mockImplementationOnce(() => ({
      promise: jest.fn().mockRejectedValue({
        name: 'ConditionalCheckFailedException',
      }),
    }));

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(409);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('DUPLICATE_DID');
  });

  it('should return 500 for unexpected errors', async () => {
    mockPutFn.mockImplementationOnce(() => ({
      promise: jest.fn().mockRejectedValue(new Error('DB Error')),
    }));

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(500);
    const body = JSON.parse(result.body);
    expect(body.code).toBe('INTERNAL_ERROR');
  });
});
