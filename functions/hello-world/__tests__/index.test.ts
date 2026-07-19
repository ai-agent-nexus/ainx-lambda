import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { handler } from './index';

// Mock dependencies
jest.mock('@ainx/logger');
jest.mock('@ainx/shared-utils');

describe('hello-world handler', () => {
  let mockEvent: Partial<APIGatewayProxyEvent>;

  beforeEach(() => {
    mockEvent = {
      path: '/hello',
      httpMethod: 'GET',
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 with hello message', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Hello from AINX Lambda!');
  });

  it('should include timestamp in response', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);
    const body = JSON.parse(result.body);

    expect(body.timestamp).toBeDefined();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('should include path in response', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);
    const body = JSON.parse(result.body);

    expect(body.path).toBe('/hello');
  });

  it('should handle errors gracefully', async () => {
    // Mock formatResponse to throw an error
    jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('Test error');
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(500);
    expect(result.body).toContain('Internal server error');
  });
});
