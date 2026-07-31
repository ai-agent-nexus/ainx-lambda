import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import {
  isValidDid,
  isValidInvitationCode,
  isInvitationExpired,
  generateRequestId,
  CONNECTION_LIMIT,
  ConnectionRequestStatus,
  SendConnectionRequest,
} from '@ainx/connection-utils';

const logger = new Logger('send-request');
const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const CONNECTION_REQUESTS_TABLE_NAME = process.env.CONNECTION_REQUESTS_TABLE_NAME!;
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME!;
const INVITATIONS_TABLE_NAME = process.env.INVITATIONS_TABLE_NAME!;
const AGENT_REGISTRATION_TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME!;

if (
  !CONNECTION_REQUESTS_TABLE_NAME ||
  !CONNECTIONS_TABLE_NAME ||
  !INVITATIONS_TABLE_NAME ||
  !AGENT_REGISTRATION_TABLE_NAME
) {
  throw new Error('Required environment variables are missing');
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Send request invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    if (event.path !== '/connections/requests' || event.httpMethod !== 'POST') {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }

    const body = parseBody<SendConnectionRequest>(event.body);
    if (!body) {
      logger.warn('Invalid or missing request body');
      return formatResponse(400, {
        error: 'Invalid request body',
        code: 'INVALID_BODY',
      });
    }

    const validation = validateInput(body as unknown as Record<string, unknown>, [
      'toDid',
      'invitationCode',
    ]);
    if (!validation.valid) {
      logger.warn('Missing required fields', { missing: validation.missingFields });
      return formatResponse(400, {
        error: `Missing required fields: ${validation.missingFields.join(', ')}`,
        code: 'MISSING_FIELDS',
      });
    }

    const { toDid, invitationCode } = body;
    const fromDid = event.requestContext.authorizer?.did as string;

    if (!fromDid) {
      logger.warn('Missing DID in request context');
      return formatResponse(401, {
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      });
    }

    if (fromDid === toDid) {
      logger.warn('Attempt to connect to self', { fromDid });
      return formatResponse(400, {
        error: 'Cannot connect to yourself',
        code: 'INVALID_REQUEST',
      });
    }

    if (!isValidDid(toDid)) {
      logger.warn('Invalid DID format', { toDid });
      return formatResponse(400, {
        error: 'Invalid DID format',
        code: 'INVALID_DID',
      });
    }

    if (!isValidInvitationCode(invitationCode)) {
      logger.warn('Invalid invitation code format', { invitationCode });
      return formatResponse(400, {
        error: 'Invalid invitation code format',
        code: 'INVALID_INVITATION',
      });
    }

    const invitationResult = await dynamodb.send(
      new GetCommand({
        TableName: INVITATIONS_TABLE_NAME,
        Key: { invitationCode },
      })
    );

    if (!invitationResult.Item) {
      logger.warn('Invitation not found', { invitationCode });
      return formatResponse(400, {
        error: 'Invalid or expired invitation',
        code: 'INVALID_INVITATION',
      });
    }

    const invitation = invitationResult.Item;

    if (isInvitationExpired(invitation.expiresAt as string)) {
      logger.warn('Invitation expired', { invitationCode, expiresAt: invitation.expiresAt });
      return formatResponse(400, {
        error: 'Invitation has expired',
        code: 'EXPIRED_INVITATION',
      });
    }

    const agentResult = await dynamodb.send(
      new QueryCommand({
        TableName: AGENT_REGISTRATION_TABLE_NAME,
        IndexName: 'DidIndex',
        KeyConditionExpression: 'did = :did',
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':did': toDid,
          ':status': 'active',
        },
      })
    );

    if (!agentResult.Items || agentResult.Items.length === 0) {
      logger.warn('Target agent not found or not active', { toDid });
      return formatResponse(400, {
        error: 'Target agent not found or not active',
        code: 'AGENT_NOT_FOUND',
      });
    }

    const existingRequest = await dynamodb.send(
      new QueryCommand({
        TableName: CONNECTION_REQUESTS_TABLE_NAME,
        IndexName: 'ToDidIndex',
        KeyConditionExpression: 'toDid = :toDid',
        FilterExpression: '#status = :status AND fromDid = :fromDid',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':toDid': toDid,
          ':status': ConnectionRequestStatus.PENDING,
          ':fromDid': fromDid,
        },
      })
    );

    if (existingRequest.Items && existingRequest.Items.length > 0) {
      logger.warn('Duplicate connection request', { fromDid, toDid });
      return formatResponse(409, {
        error: 'Connection request already pending',
        code: 'CONFLICT',
      });
    }

    const connectionCount = await dynamodb.send(
      new QueryCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        KeyConditionExpression: 'userId = :userId',
        FilterExpression: '#status = :status',
        ExpressionAttributeNames: {
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':userId': fromDid,
          ':status': 'CONNECTED',
        },
        Select: 'COUNT',
      })
    );

    if ((connectionCount.Count || 0) >= CONNECTION_LIMIT) {
      logger.warn('Connection limit reached', { fromDid, count: connectionCount.Count });
      return formatResponse(429, {
        error: `Connection limit reached (${CONNECTION_LIMIT})`,
        code: 'TOO_MANY_CONNECTIONS',
      });
    }

    const requestId = generateRequestId();
    const now = new Date().toISOString();

    await dynamodb.send(
      new PutCommand({
        TableName: CONNECTION_REQUESTS_TABLE_NAME,
        Item: {
          requestId,
          fromDid,
          toDid,
          invitationCode,
          status: ConnectionRequestStatus.PENDING,
          createdAt: now,
          updatedAt: now,
          expiresAt: invitation.expiresAt,
          ttl: invitation.ttl,
        },
      })
    );

    logger.info('Connection request created', { requestId, fromDid, toDid, invitationCode });

    return formatResponse(201, {
      requestId,
      fromDid,
      toDid,
      status: ConnectionRequestStatus.PENDING,
      createdAt: now,
      expiresAt: invitation.expiresAt,
    });
  } catch (error) {
    logger.error('Error in send-request handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
