import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import crypto from 'crypto';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { parseDidKey } from '@ainx/did-utils';
import { verifySignature } from '@ainx/crypto-utils';

const logger = new Logger('agent-registration');
const dynamodb = new DynamoDB.DocumentClient();
const TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME;
const DID_UNIQUENESS_TABLE_NAME = process.env.DID_UNIQUENESS_TABLE_NAME;
const NONCE_TABLE_NAME = process.env.NONCE_TABLE_NAME;

if (!TABLE_NAME || !DID_UNIQUENESS_TABLE_NAME || !NONCE_TABLE_NAME) {
  throw new Error('Required environment variables are missing');
}

const TTL_DAYS = 90;

interface AgentRegistrationRequest {
  did: string;
  signature: string;
  metadata: Record<string, unknown>;
}

interface RotateKeyRequest {
  oldDid: string;
  newDid: string;
  signature: string;
  timestamp: number;
  nonce: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Agent registration invoked', {
      path: event.path,
      method: event.httpMethod,
    });

    const path = event.path;
    const method = event.httpMethod;

    if (path === '/agents/register' && method === 'POST') {
      return await handleRegister(event);
    } else if (path === '/agents/rotate-key' && method === 'POST') {
      return await handleRotateKey(event);
    } else {
      return formatResponse(404, {
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    }
  } catch (error) {
    logger.error('Error in agent-registration handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};

async function handleRegister(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<AgentRegistrationRequest>(event.body);
  if (!body) {
    logger.warn('Invalid or missing request body');
    return formatResponse(400, {
      error: 'Invalid request body',
      code: 'INVALID_BODY',
    });
  }

  const validation = validateInput(body as unknown as Record<string, unknown>, [
    'did',
    'signature',
    'metadata',
  ]);
  if (!validation.valid) {
    logger.warn('Missing required fields', { missing: validation.missingFields });
    return formatResponse(400, {
      error: `Missing required fields: ${validation.missingFields.join(', ')}`,
      code: 'MISSING_FIELDS',
    });
  }

  const { did, signature, metadata } = body;

  let publicKey: Buffer;
  try {
    const parsed = parseDidKey(did);
    publicKey = parsed.publicKey;
  } catch (err) {
    logger.warn('Invalid DID format', { did, error: (err as Error).message });
    return formatResponse(400, {
      error: 'Invalid DID format',
      code: 'INVALID_DID',
    });
  }

  const message = JSON.stringify({ did, metadata });
  const signatureBuffer = Buffer.from(signature, 'base64');

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(publicKey, message, signatureBuffer);
  } catch (err) {
    logger.warn('Signature verification error', { error: (err as Error).message });
    return formatResponse(400, {
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  if (!signatureValid) {
    logger.warn('Signature verification failed', { did });
    return formatResponse(400, {
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60;
  const userId = crypto.randomUUID();

  const item = {
    userId,
    did,
    status: 'active',
    publicKey: publicKey.toString('base64'),
    metadata,
    didHistory: [{ did, revokedAt: null, reason: null }],
    registeredAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ttl,
  };

  try {
    await dynamodb
      .transactWrite({
        TransactItems: [
          {
            Put: {
              TableName: DID_UNIQUENESS_TABLE_NAME,
              Item: {
                did,
                userId,
                createdAt: now.toISOString(),
                ttl,
              },
              ConditionExpression: 'attribute_not_exists(did)',
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: item,
              ConditionExpression: 'attribute_not_exists(userId) AND attribute_not_exists(did)',
            },
          },
        ],
      })
      .promise();
  } catch (err) {
    if ((err as Error).name === 'TransactionCanceledException') {
      logger.warn('Duplicate DID registration attempt', { did });
      return formatResponse(409, {
        error: 'DID already registered',
        code: 'DUPLICATE_DID',
      });
    }
    throw err;
  }

  logger.info('Agent registered successfully', { did, userId, ttl });

  return formatResponse(201, {
    message: 'Agent registered successfully',
    did,
    registeredAt: now.toISOString(),
    ttl,
  });
}

async function handleRotateKey(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = parseBody<RotateKeyRequest>(event.body);
  if (!body) {
    logger.warn('Invalid or missing request body');
    return formatResponse(400, {
      error: 'Invalid request body',
      code: 'INVALID_BODY',
    });
  }

  const validation = validateInput(body as unknown as Record<string, unknown>, [
    'oldDid',
    'newDid',
    'signature',
    'timestamp',
    'nonce',
  ]);
  if (!validation.valid) {
    logger.warn('Missing required fields', { missing: validation.missingFields });
    return formatResponse(400, {
      error: `Missing required fields: ${validation.missingFields.join(', ')}`,
      code: 'MISSING_FIELDS',
    });
  }

  const { oldDid, newDid, signature, timestamp, nonce } = body;

  // Verify timestamp
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    logger.warn('Timestamp expired', { timestamp, now });
    return formatResponse(400, {
      error: 'Timestamp expired',
      code: 'TIMESTAMP_EXPIRED',
    });
  }

  // Verify nonce
  try {
    await dynamodb
      .put({
        TableName: NONCE_TABLE_NAME,
        Item: {
          nonce,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 600,
        },
        ConditionExpression: 'attribute_not_exists(nonce)',
      })
      .promise();
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') {
      logger.warn('Nonce already used', { nonce });
      return formatResponse(400, {
        error: 'Nonce already used',
        code: 'REUSED_NONCE',
      });
    }
    throw err;
  }

  // Verify signature
  const message = `POST /agents/rotate-key\nrotate:${oldDid}:${newDid}:${timestamp}:${nonce}`;
  const signatureBuffer = Buffer.from(signature, 'base64');

  let oldPublicKey: Buffer;
  try {
    const parsed = parseDidKey(oldDid);
    oldPublicKey = parsed.publicKey;
  } catch (err) {
    logger.warn('Invalid old DID format', { oldDid, error: (err as Error).message });
    return formatResponse(400, {
      error: 'Invalid old DID format',
      code: 'INVALID_DID',
    });
  }

  let signatureValid: boolean;
  try {
    signatureValid = verifySignature(oldPublicKey, message, signatureBuffer);
  } catch (err) {
    logger.warn('Signature verification error', { error: (err as Error).message });
    return formatResponse(400, {
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  if (!signatureValid) {
    logger.warn('Signature verification failed', { oldDid });
    return formatResponse(400, {
      error: 'Invalid signature',
      code: 'INVALID_SIGNATURE',
    });
  }

  // Verify oldDid is active
  const oldDidQuery = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'DidIndex',
      KeyConditionExpression: 'did = :did',
      FilterExpression: 'status = :status',
      ExpressionAttributeValues: {
        ':did': oldDid,
        ':status': 'active',
      },
    })
    .promise();

  if (!oldDidQuery.Items || oldDidQuery.Items.length === 0) {
    logger.warn('Old DID not found or not active', { oldDid });
    return formatResponse(400, {
      error: 'Old DID not found or not active',
      code: 'DID_REVOKED',
    });
  }

  const userId = oldDidQuery.Items[0].userId;

  // Verify newDid format
  let newPublicKey: Buffer;
  try {
    const parsed = parseDidKey(newDid);
    newPublicKey = parsed.publicKey;
  } catch (err) {
    logger.warn('Invalid new DID format', { newDid, error: (err as Error).message });
    return formatResponse(400, {
      error: 'Invalid new DID format',
      code: 'INVALID_DID',
    });
  }

  // Verify newDid uniqueness
  const newDidQuery = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: 'DidIndex',
      KeyConditionExpression: 'did = :did',
      ExpressionAttributeValues: {
        ':did': newDid,
      },
    })
    .promise();

  if (newDidQuery.Items && newDidQuery.Items.length > 0) {
    logger.warn('New DID already exists', { newDid });
    return formatResponse(409, {
      error: 'New DID already exists',
      code: 'DUPLICATE_DID',
    });
  }

  const nowDate = new Date();
  const ttl = Math.floor(nowDate.getTime() / 1000) + TTL_DAYS * 24 * 60 * 60;

  try {
    await dynamodb
      .transactWrite({
        TransactItems: [
          {
            Put: {
              TableName: DID_UNIQUENESS_TABLE_NAME,
              Item: {
                did: newDid,
                userId,
                createdAt: nowDate.toISOString(),
                ttl,
              },
              ConditionExpression: 'attribute_not_exists(did)',
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                userId,
                did: newDid,
                status: 'active',
                publicKey: newPublicKey.toString('base64'),
                metadata: oldDidQuery.Items[0].metadata,
                didHistory: [
                  ...oldDidQuery.Items[0].didHistory,
                  { did: newDid, revokedAt: null, reason: null },
                ],
                registeredAt: oldDidQuery.Items[0].registeredAt,
                updatedAt: nowDate.toISOString(),
                ttl,
              },
            },
          },
          {
            Update: {
              TableName: TABLE_NAME,
              Key: {
                userId,
                did: oldDid,
              },
              UpdateExpression: 'SET status = :status, revokedAt = :revokedAt',
              ExpressionAttributeValues: {
                ':status': 'revoked',
                ':revokedAt': nowDate.toISOString(),
              },
            },
          },
        ],
      })
      .promise();
  } catch (err) {
    if ((err as Error).name === 'TransactionCanceledException') {
      logger.warn('Concurrent modification detected', { oldDid, newDid });
      return formatResponse(409, {
        error: 'Concurrent modification detected',
        code: 'CONCURRENT_MODIFICATION',
      });
    }
    throw err;
  }

  logger.info('Key rotated successfully', { oldDid, newDid, userId });

  return formatResponse(200, {
    message: 'Key rotated successfully',
    did: newDid,
    updatedAt: nowDate.toISOString(),
  });
}
