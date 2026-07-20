import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB } from 'aws-sdk';
import { Logger } from '@ainx/logger';
import { formatResponse, parseBody, validateInput } from '@ainx/shared-utils';
import { parseDidKey } from '@ainx/did-utils';
import { verifySignature } from '@ainx/crypto-utils';

const logger = new Logger('agent-registration');
const dynamodb = new DynamoDB.DocumentClient();
const TABLE_NAME = process.env.AGENT_REGISTRATION_TABLE_NAME || '';
const TTL_DAYS = 90;

interface AgentRegistrationRequest {
  did: string;
  signature: string;
  metadata: Record<string, unknown>;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    logger.info('Agent registration invoked', {
      path: event.path,
      method: event.httpMethod,
    });

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

    const item = {
      did,
      signature,
      metadata,
      registeredAt: now.toISOString(),
      ttl,
    };

    try {
      await dynamodb
        .put({
          TableName: TABLE_NAME,
          Item: item,
          ConditionExpression: 'attribute_not_exists(did)',
        })
        .promise();
    } catch (err) {
      if ((err as Error).name === 'ConditionalCheckFailedException') {
        logger.warn('Duplicate DID registration attempt', { did });
        return formatResponse(409, {
          error: 'DID already registered',
          code: 'DUPLICATE_DID',
        });
      }
      throw err;
    }

    logger.info('Agent registered successfully', { did, ttl });

    return formatResponse(201, {
      message: 'Agent registered successfully',
      did,
      registeredAt: now.toISOString(),
      ttl,
    });
  } catch (error) {
    logger.error('Error in agent-registration handler', { error });
    return formatResponse(500, {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });
  }
};
