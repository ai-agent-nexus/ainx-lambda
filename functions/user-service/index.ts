import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@ainx/logger';
import { formatResponse, validateInput } from '@ainx/shared-utils';

const logger = new Logger('user-service');

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('User service invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    // Route based on HTTP method and path
    if (event.httpMethod === 'GET' && event.path === '/users') {
      return getUsers();
    }

    if (event.httpMethod === 'POST' && event.path === '/users') {
      return createUser(event);
    }

    if (event.httpMethod === 'GET' && event.path?.startsWith('/users/')) {
      const userId = event.path.split('/').pop();
      return getUserById(userId!);
    }

    return formatResponse(404, {
      message: 'Not found',
    });
  } catch (error) {
    logger.error('Error in user-service handler', { error });

    return formatResponse(500, {
      message: 'Internal server error',
    });
  }
};

function getUsers() {
  // TODO: Implement actual database query
  return formatResponse(200, {
    users: [
      { id: '1', name: 'John Doe', email: 'john@example.com' },
      { id: '2', name: 'Jane Smith', email: 'jane@example.com' },
    ],
  });
}

function getUserById(userId: string) {
  // TODO: Implement actual database query
  return formatResponse(200, {
    user: { id: userId, name: 'John Doe', email: 'john@example.com' },
  });
}

function createUser(event: APIGatewayProxyEvent) {
  const body = JSON.parse(event.body || '{}');
  
  const validation = validateInput(body, ['name', 'email']);
  if (!validation.valid) {
    return formatResponse(400, {
      message: `Missing required fields: ${validation.missingFields.join(', ')}`,
    });
  }

  // TODO: Implement actual database insertion
  return formatResponse(201, {
    message: 'User created successfully',
    user: {
      id: Date.now().toString(),
      name: body.name,
      email: body.email,
    },
  });
}
