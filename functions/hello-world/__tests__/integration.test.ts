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

describe('Integration: hello-world handler', () => {
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

  it('should handle GET /hello request', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);

    expect(result.statusCode).toBe(200);
    expect(result.headers).toBeDefined();
    expect(result.headers?.['Content-Type']).toBe('application/json');

    const body = JSON.parse(result.body);
    expect(body.message).toBe('Hello from AINX Lambda!');
    expect(body.timestamp).toBeDefined();
  });

  it('should handle concurrent requests', async () => {
    const requests = Array.from({ length: 10 }, () => handler(mockEvent as APIGatewayProxyEvent));

    const results = await Promise.all(requests);

    results.forEach((result) => {
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe('Hello from AINX Lambda!');
    });
  });
});
