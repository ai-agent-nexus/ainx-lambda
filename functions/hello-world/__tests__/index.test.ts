import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../index';

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
  validateInput: jest.fn(),
  generateId: jest.fn(),
  parseBody: jest.fn(),
}));

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
    const { formatResponse } = await import('@ainx/shared-utils');
    const mockedFormatResponse = jest.mocked(formatResponse);
    mockedFormatResponse.mockImplementationOnce(() => {
      throw new Error('Test error');
    });

    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(500);
    expect(result.body).toContain('Internal server error');
  });
});
