import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler } from '../index';

// Mock dependencies
jest.mock('@ainx/logger');
jest.mock('@ainx/shared-utils');

describe('user-service handler', () => {
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
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.users).toBeDefined();
      expect(Array.isArray(body.users)).toBe(true);
      expect(body.users.length).toBeGreaterThan(0);
    });

    it('should return users with required fields', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);
      const body = JSON.parse(result.body);
      const user = body.users[0];

      expect(user.id).toBeDefined();
      expect(user.name).toBeDefined();
      expect(user.email).toBeDefined();
    });
  });

  describe('GET /users/:id', () => {
    beforeEach(() => {
      mockEvent = {
        path: '/users/123',
        httpMethod: 'GET',
      };
    });

    it('should return a single user', async () => {
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe('123');
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
      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('User created successfully');
      expect(body.user).toBeDefined();
    });

    it('should return 400 for missing required fields', async () => {
      mockEvent.body = JSON.stringify({ name: 'Test User' }); // missing email

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Missing required fields');
    });

    it('should return 400 for missing name', async () => {
      mockEvent.body = JSON.stringify({ email: 'test@example.com' }); // missing name

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain('Missing required fields');
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown paths', async () => {
      mockEvent = {
        path: '/unknown',
        httpMethod: 'GET',
      };

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Not found');
    });
  });

  describe('Error handling', () => {
    it('should handle errors gracefully', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {
        throw new Error('Test error');
      });

      const result = await handler(mockEvent as APIGatewayProxyEvent);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Internal server error');
    });
  });
});
