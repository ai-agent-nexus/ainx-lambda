import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody } from '@ainx/shared-utils';
import {
  generateInvitationCode,
  calculateInvitationExpiration,
  CreateInvitationRequest,
  MAX_INVITATION_TTL_SECONDS,
} from '@ainx/connection-utils';

const logger = new Logger('create-invitation');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const INVITATIONS_TABLE_NAME = process.env.INVITATIONS_TABLE_NAME!;

if (!INVITATIONS_TABLE_NAME) {
  throw new Error('INVITATIONS_TABLE_NAME environment variable is required');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Create invitation invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/connections/invitations' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const body = parseBody<CreateInvitationRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const { expiresInSeconds } = body;

    if (expiresInSeconds !== undefined && expiresInSeconds > MAX_INVITATION_TTL_SECONDS) {
      logger.warn('Expiration time exceeds maximum', {
        expiresInSeconds,
        max: MAX_INVITATION_TTL_SECONDS,
      });
      return formatResponse(400, {
        error: `Expiration time cannot exceed ${MAX_INVITATION_TTL_SECONDS} seconds`,
        code: 'INVALID_EXPIRATION',
      });
    }

    if (expiresInSeconds !== undefined && expiresInSeconds <= 0) {
      logger.warn('Invalid expiration time', { expiresInSeconds });
      return formatResponse(400, {
        error: 'Expiration time must be positive',
        code: 'INVALID_EXPIRATION',
      });
    }

    const creatorDid = event.requestContext.authorizer?.did as string;
    if (!creatorDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    const invitationCode = generateInvitationCode();
    const { expiresAt, ttl } = calculateInvitationExpiration(expiresInSeconds);

    await dynamodb.send(
      new PutCommand({
        TableName: INVITATIONS_TABLE_NAME,
        Item: {
          invitationCode,
          creatorDid,
          expiresAt,
          createdAt: new Date().toISOString(),
          ttl,
        },
      })
    );

    logger.info('Invitation created successfully', { invitationCode, creatorDid, expiresAt });

    return formatResponse(201, {
      invitationCode,
      expiresAt,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error in create-invitation handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
