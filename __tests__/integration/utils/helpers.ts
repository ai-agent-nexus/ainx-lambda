import { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Create a mock APIGatewayProxyEvent for integration tests
 */
export function createEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    path: '/',
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: null,
    pathParameters: null,
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: '123456789012',
      apiId: 'test-api-id',
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      path: '/',
      stage: 'test',
      requestId: 'test-request-id',
      requestTimeEpoch: Date.now(),
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: null,
        userArn: null,
      },
    },
    resource: '/',
    stageVariables: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    ...overrides,
  } as APIGatewayProxyEvent;
}

/**
 * Create a mock APIGatewayProxyEvent with authorization context
 */
export function createAuthorizedEvent(
  did: string,
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent {
  return createEvent({
    requestContext: {
      ...createEvent().requestContext,
      authorizer: { did },
    },
    ...overrides,
  });
}

/**
 * Set environment variables for integration tests
 */
export function setupTestEnv(envVars: Record<string, string> = {}): void {
  const defaults: Record<string, string> = {
    AGENT_REGISTRATION_TABLE_NAME: 'test-agent-registration-table',
    DID_UNIQUENESS_TABLE_NAME: 'test-did-uniqueness-table',
    REFRESH_TOKEN_TABLE_NAME: 'test-refresh-token-table',
    NONCE_TABLE_NAME: 'test-nonce-table',
    CHALLENGE_TABLE_NAME: 'test-challenge-table',
    TOKEN_BLACKLIST_TABLE_NAME: 'test-token-blacklist-table',
    CONNECTIONS_TABLE_NAME: 'test-connections-table',
    CONNECTION_REQUESTS_TABLE_NAME: 'test-connection-requests-table',
    INVITATIONS_TABLE_NAME: 'test-invitations-table',
    MESSAGES_TABLE_NAME: 'test-messages-table',
    JWT_PUBLIC_KEY: 'test-public-key',
    JWT_ISSUER: 'ainx-api',
    JWT_EXPIRES_IN_SECONDS: '3600',
    REFRESH_TOKEN_TTL_DAYS: '7',
  };

  Object.entries({ ...defaults, ...envVars }).forEach(([key, value]) => {
    process.env[key] = value;
  });
}
