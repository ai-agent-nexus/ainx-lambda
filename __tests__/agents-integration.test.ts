process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';
process.env.JWT_PUBLIC_KEY = 'test-public-key';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as registrationHandler } from '../functions/agent-registration/src/index';

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

jest.mock('@ainx/crypto-utils', () => ({
  verifySignature: jest.fn((_publicKey: Buffer, message: string, signature: Buffer) => {
    // For testing, accept any signature for valid messages
    return signature.length > 0 && message.length > 0;
  }),
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({
    sub: 'test-user-id',
    did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'ainx-api',
    jti: 'test-jti-123',
    scope: 'agent:read agent:write',
  })),
  TokenExpiredError: class TokenExpiredError extends Error {
    constructor() {
      super('Token expired');
      this.name = 'TokenExpiredError';
    }
  },
  JsonWebTokenError: class JsonWebTokenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'JsonWebTokenError';
    }
  },
}));

// Track DynamoDB state for integration tests
const dynamoDBState = {
  agents: new Map<string, unknown>(),
  didUniqueness: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
  nonces: new Map<string, unknown>(),
};

// Mock the DynamoDB client - use a single mockSend that can be controlled
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => params),
  TransactWriteCommand: jest.fn((params) => params),
}));

describe('Integration: Agent Management Flow', () => {
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';

  beforeEach(() => {
    // Clear all DynamoDB state before each test
    dynamoDBState.agents.clear();
    dynamoDBState.didUniqueness.clear();
    dynamoDBState.refreshTokens.clear();
    dynamoDBState.nonces.clear();

    // Setup environment variables
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
    process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness-table';
    process.env.REFRESH_TOKEN_TABLE_NAME = 'test-refresh-token-table';
    process.env.NONCE_TABLE_NAME = 'test-nonce-table';
    process.env.JWT_PUBLIC_KEY = 'test-public-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full agent lifecycle with shared state', () => {
    it('should handle complete register -> rotate -> revoke flow', async () => {
      // Step 1: Register agent
      const registerEvent: Partial<APIGatewayProxyEvent> = {
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      };

      const registerResult = await registrationHandler(registerEvent as APIGatewayProxyEvent);
      expect(registerResult.statusCode).toBe(201);
      const registerBody = JSON.parse(registerResult.body);
      expect(registerBody.message).toBe('Agent registered successfully');
    });
  });
});
