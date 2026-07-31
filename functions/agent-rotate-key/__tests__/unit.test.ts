process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-table';
process.env.DID_UNIQUENESS_TABLE_NAME = 'test-did-uniqueness';
process.env.NONCE_TABLE_NAME = 'test-nonce-table';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';
import { verifySignature } from '@ainx/crypto-utils';

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

describe('agent-rotate-key handler', () => {
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
    
    mockSend.mockResolvedValue({
      Items: [{
        userId: 'test-user-id',
        did: validBody.oldDid,
        status: 'active',
      }],
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Request validation', () => {
    it('should return 400 for invalid request body', async () => {
      mockEvent.body = 'not-json';

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_BODY');
    });

    it('should return 400 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({ oldDid: 'test-did' });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });

    it('should return 400 for expired timestamp', async () => {
      mockEvent.body = JSON.stringify({
        ...validBody,
        timestamp: Math.floor(Date.now() / 1000) - 400,
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('TIMESTAMP_EXPIRED');
    });
  });

  describe('DID validation', () => {
    it('should return 400 for invalid old DID format', async () => {
      mockEvent.body = JSON.stringify({
        ...validBody,
        oldDid: 'invalid-did',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });

    it('should return 400 for revoked old DID', async () => {
      mockSend
        .mockResolvedValueOnce({}) // nonce put
        .mockResolvedValueOnce({ Items: [] }); // oldDid query

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('DID_REVOKED');
    });

    it('should return 400 for invalid new DID format', async () => {
      mockSend.mockResolvedValueOnce({
        Items: [{
          userId: 'test-user-id',
          did: validBody.oldDid,
          status: 'active',
        }],
      });

      mockEvent.body = JSON.stringify({
        ...validBody,
        newDid: 'invalid-did',
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });
  });

  describe('Signature validation', () => {
    it('should return 400 for invalid signature', async () => {
      (verifySignature as jest.Mock).mockReturnValueOnce(false);

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Error handling', () => {
    it('should return 500 on unexpected error', async () => {
      mockSend.mockRejectedValueOnce(new Error('DB Error'));

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INTERNAL_ERROR');
    });
  });
});
