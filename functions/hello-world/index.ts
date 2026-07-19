import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@ainx/logger';
import { formatResponse } from '@ainx/shared-utils';

const logger = new Logger('hello-world');

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Hello World function invoked', { 
      path: event.path,
      method: event.httpMethod 
    });

    return formatResponse(200, {
      message: 'Hello from AINX Lambda!',
      timestamp: new Date().toISOString(),
      path: event.path,
    });
  } catch (error) {
    logger.error('Error in hello-world handler', { error });
    
    return formatResponse(500, {
      message: 'Internal server error',
    });
  }
};
