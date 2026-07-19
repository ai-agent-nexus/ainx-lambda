import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../index';

// Mock dependencies
jest.mock('@ainx/logger');
jest.mock('@ainx/shared-utils');

describe('Integration: user-service handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/users',
      httpMethod: 'GET',
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /users', () => {
    it('should return list of users', async () => {
      const result: APIGatewayProxyResult = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.users).toBeDefined();
      expect(Array.isArray(body.users)).toBe(true);
    });
  });

  describe('POST /users', () => {
    beforeEach(() => {
      mockEvent = {
        path: '/users',
        httpMethod: 'POST',
        body: JSON.stringify({
          name: 'Test User',
          email: 'test@example.com',
        }),
      };
    });

    it('should create a new user', async () => {
      const result: APIGatewayProxyResult = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('User created successfully');
      expect(body.user).toBeDefined();
      expect(body.user.name).toBe('Test User');
      expect(body.user.email).toBe('test@example.com');
    });

    it('should validate required fields', async () => {
      mockEvent.body = JSON.stringify({ name: 'Test User' }); // missing email

      const result: APIGatewayProxyResult = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Missing required fields');
    });
  });

  describe('GET /users/:id', () => {
    beforeEach(() => {
      mockEvent = {
        path: '/users/123',
        httpMethod: 'GET',
      };
    });

    it('should return a specific user', async () => {
      const result: APIGatewayProxyResult = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe('123');
    });
  });

  describe('Error handling', () => {
    it('should handle invalid JSON body', async () => {
      mockEvent = {
        path: '/users',
        httpMethod: 'POST',
        body: 'invalid json',
      };

      const result: APIGatewayProxyResult = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Internal server error');
    });
  });
});
