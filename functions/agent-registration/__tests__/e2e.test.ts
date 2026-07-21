import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../src/index';

/**
 * E2E Tests for agent-registration Lambda
 * 
 * These tests simulate real API Gateway requests and verify the complete flow.
 * Run with: npm run test:e2e
 * 
 * Requirements:
 * - Local DynamoDB (or mock)
 * - Proper environment variables
 */

describe('E2E: agent-registration', () => {
  const createEvent = (body: Record<string, unknown>): APIGatewayProxyEvent => ({
    path: '/agents/register',
    httpMethod: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
    },
    queryStringParameters: null,
    pathParameters: null,
    requestContext: {} as any,
    resource: '',
    stageVariables: null,
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
  } as APIGatewayProxyEvent);

  beforeEach(() => {
    // Reset environment
    process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';
  });

  describe('Happy Path', () => {
    it('should successfully register a new agent with valid did:key', async () => {
      // Arrange
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: {
          name: 'Test Agent',
          description: 'A test agent for E2E testing',
        },
      };

      // Act
      const result = await handler(createEvent(requestBody));

      // Assert
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Agent registered successfully');
      expect(body.did).toBe(requestBody.did);
      expect(body.registeredAt).toBeDefined();
      expect(body.ttl).toBeDefined();
    });

    it('should accept minimal metadata', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: {},
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.did).toBe(requestBody.did);
    });
  });

  describe('Error Cases', () => {
    it('should return 400 for invalid DID format', async () => {
      const requestBody = {
        did: 'invalid-did-format',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: { name: 'Test' },
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_DID');
    });

    it('should return 400 for missing required fields', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        // missing signature and metadata
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('MISSING_FIELDS');
    });

    it('should return 409 for duplicate DID registration', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: { name: 'Test' },
      };

      // First registration
      const firstResult = await handler(createEvent(requestBody));
      expect(firstResult.statusCode).toBe(201);

      // Second registration with same DID
      const secondResult = await handler(createEvent(requestBody));
      expect(secondResult.statusCode).toBe(409);
      const body = JSON.parse(secondResult.body);
      expect(body.code).toBe('DUPLICATE_DID');
    });

    it('should return 400 for invalid signature', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'invalid-signature',
        metadata: { name: 'Test' },
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.code).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty request body', async () => {
      const event = createEvent({});
      event.body = null;

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
    });

    it('should handle malformed JSON in body', async () => {
      const event = createEvent({});
      event.body = 'not-valid-json';

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
    });

    it('should handle large metadata', async () => {
      const largeMetadata = {
        name: 'Test',
        data: 'x'.repeat(10000),
      };

      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: largeMetadata,
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(201);
    });
  });

  describe('Security', () => {
    it('should handle SQL injection attempt in metadata', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: {
          name: "'; DROP TABLE agents; --",
        },
      };

      const result = await handler(createEvent(requestBody));

      // Should still succeed, DynamoDB is NoSQL
      expect(result.statusCode).toBe(201);
    });

    it('should handle XSS attempt in metadata', async () => {
      const requestBody = {
        did: 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ',
        signature: 'dGVzdHNpZ25hdHVyZQ==',
        metadata: {
          name: '<script>alert("xss")</script>',
        },
      };

      const result = await handler(createEvent(requestBody));

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      // Should store as-is, client should handle sanitization
      expect(body.message).toBe('Agent registered successfully');
    });
  });
});
