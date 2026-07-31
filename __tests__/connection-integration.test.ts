process.env.CONNECTIONS_TABLE_NAME = 'test-connections-table';
process.env.CONNECTION_REQUESTS_TABLE_NAME = 'test-connection-requests-table';
process.env.INVITATIONS_TABLE_NAME = 'test-invitations-table';
process.env.AGENT_REGISTRATION_TABLE_NAME = 'test-agent-registration-table';

import { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as createInvitationHandler } from '../functions/connection-create-invitation/src/index';
import { handler as sendRequestHandler } from '../functions/connection-send-request/src/index';
import { handler as acceptRequestHandler } from '../functions/connection-accept-request/src/index';
import { handler as rejectHandler } from '../functions/connection-accept-request/src/reject';
import { handler as listConnectionsHandler } from '../functions/connection-list-connections/src/index';
import { handler as removeConnectionHandler } from '../functions/connection-remove-connection/src/index';

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
  validateInput: jest.fn((input: Record<string, unknown>, requiredFields: string[]) => {
    const missingFields = requiredFields.filter((field) => !input[field]);
    return {
      valid: missingFields.length === 0,
      missingFields,
    };
  }),
  parseBody: jest.fn((body: string | null) => {
    if (!body) return null;
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }),
}));

jest.mock('@ainx/connection-utils', () => ({
  generateInvitationCode: jest.fn(
    () => `inv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  ),
  calculateInvitationExpiration: jest.fn((expiresInSeconds?: number) => {
    const seconds = expiresInSeconds || 1800;
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    const ttl = Math.floor(Date.now() / 1000) + seconds;
    return { expiresAt, ttl };
  }),
  isValidInvitationCode: jest.fn((code: string) => code && code.startsWith('inv_')),
  isInvitationExpired: jest.fn((expiresAt: string) => new Date(expiresAt) < new Date()),
  generateRequestId: jest.fn(() => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`),
  isValidDid: jest.fn((did: string) => did && did.startsWith('did:key:')),
  CONNECTION_LIMIT: 100,
  DEFAULT_INVITATION_TTL_SECONDS: 1800,
  MAX_INVITATION_TTL_SECONDS: 86400,
  ConnectionStatus: {
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    BLOCKED: 'BLOCKED',
  },
  ConnectionRequestStatus: {
    PENDING: 'PENDING',
    ACCEPTED: 'ACCEPTED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
  },
}));

// In-memory DynamoDB state for integration tests
interface ConnectionItem {
  userId: string;
  connectionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

interface RequestItem {
  requestId: string;
  fromDid: string;
  toDid: string;
  invitationCode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ttl?: number;
}

interface InvitationItem {
  invitationCode: string;
  creatorDid: string;
  expiresAt: string;
  ttl: number;
  createdAt: string;
}

const connectionsState = new Map<string, ConnectionItem>();
const requestsState = new Map<string, RequestItem>();
const invitationsState = new Map<string, InvitationItem>();
const agentRegistrationState = new Map<string, { did: string; status: string }>();

const getConnectionKey = (userId: string, connectionId: string) => `${userId}#${connectionId}`;

const deleteCommands = new WeakSet<object>();

function markAsDelete(command: unknown): void {
  if (typeof command === 'object' && command !== null) {
    deleteCommands.add(command);
  }
}

const mockSend = jest.fn((command: unknown) => {
  const cmd = command as {
    TableName: string;
    Key?: Record<string, unknown>;
    Item?: Record<string, unknown>;
    ExpressionAttributeValues?: Record<string, unknown>;
    ExpressionAttributeNames?: Record<string, string>;
    ConditionExpression?: string;
    UpdateExpression?: string;
    Select?: string;
    TransactItems?: Array<{
      Put?: { TableName: string; Item: Record<string, unknown> };
      Update?: {
        TableName: string;
        Key: Record<string, unknown>;
        UpdateExpression: string;
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
      };
    }>;
  };

  const isDelete = typeof command === 'object' && command !== null && deleteCommands.has(command);

  if (cmd.TransactItems) {
    for (const item of cmd.TransactItems) {
      if (item.Put && item.Put.TableName.includes('connection')) {
        const key = getConnectionKey(
          item.Put.Item.userId as string,
          item.Put.Item.connectionId as string
        );
        connectionsState.set(key, item.Put.Item as unknown as ConnectionItem);
      }
      if (item.Update && item.Update.TableName.includes('connection')) {
        const key = getConnectionKey(
          item.Update.Key.userId as string,
          item.Update.Key.connectionId as string
        );
        const existing = connectionsState.get(key);
        if (existing) {
          const values = item.Update.ExpressionAttributeValues || {};
          if (values[':status']) existing.status = values[':status'] as string;
          if (values[':updatedAt']) existing.updatedAt = values[':updatedAt'] as string;
        }
      }
    }
    return Promise.resolve({});
  }

  if (cmd.TableName.includes('invitation')) {
    if (cmd.Item) {
      invitationsState.set(
        cmd.Item.invitationCode as string,
        cmd.Item as unknown as InvitationItem
      );
      return Promise.resolve({});
    }
    if (cmd.Key) {
      const code = cmd.Key.invitationCode as string;
      const item = invitationsState.get(code);
      return Promise.resolve({ Item: item });
    }
  }

  if (cmd.TableName.includes('connection-request')) {
    if (cmd.Item) {
      requestsState.set(cmd.Item.requestId as string, cmd.Item as unknown as RequestItem);
      return Promise.resolve({});
    }
    if (cmd.Key) {
      const requestId = cmd.Key.requestId as string;
      const item = requestsState.get(requestId);
      if (isDelete) {
        requestsState.delete(requestId);
      }
      return Promise.resolve({ Item: item });
    }
    if (cmd.ExpressionAttributeValues?.[':toDid']) {
      const toDid = cmd.ExpressionAttributeValues[':toDid'] as string;
      const fromDid = cmd.ExpressionAttributeValues[':fromDid'] as string;
      const items: RequestItem[] = [];
      for (const [, item] of requestsState) {
        if (item.toDid === toDid && item.fromDid === fromDid && item.status === 'PENDING') {
          items.push(item);
        }
      }
      return Promise.resolve({ Items: items, Count: items.length });
    }
  }

  if (cmd.TableName.includes('connection')) {
    if (cmd.Item) {
      const key = getConnectionKey(cmd.Item.userId as string, cmd.Item.connectionId as string);
      connectionsState.set(key, cmd.Item as unknown as ConnectionItem);
      return Promise.resolve({});
    }
    if (cmd.Key) {
      const key = getConnectionKey(cmd.Key.userId as string, cmd.Key.connectionId as string);
      const item = connectionsState.get(key);
      if (isDelete) {
        connectionsState.delete(key);
      }
      return Promise.resolve({ Item: item });
    }
    if (cmd.ExpressionAttributeValues?.[':userId']) {
      const userId = cmd.ExpressionAttributeValues[':userId'] as string;
      const items: ConnectionItem[] = [];
      for (const [, item] of connectionsState) {
        if (item.userId === userId) {
          if (cmd.ExpressionAttributeValues?.[':status']) {
            if (item.status === cmd.ExpressionAttributeValues[':status']) {
              items.push(item);
            }
          } else {
            items.push(item);
          }
        }
      }
      return Promise.resolve({ Items: items, Count: items.length });
    }
  }

  if (cmd.TableName.includes('agent-registration')) {
    if (cmd.ExpressionAttributeValues?.[':did']) {
      const did = cmd.ExpressionAttributeValues[':did'] as string;
      const items: Array<Record<string, unknown>> = [];
      const agent = agentRegistrationState.get(did);
      if (agent && (agent.status === 'active' || agent.status === 'ACTIVE')) {
        items.push(agent as unknown as Record<string, unknown>);
      }
      return Promise.resolve({ Items: items });
    }
  }

  return Promise.resolve({});
});

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (command: unknown) => mockSend(command),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => {
    const cmd = { ...params };
    markAsDelete(cmd);
    return cmd;
  }),
  TransactWriteCommand: jest.fn((params) => params),
}));

describe('Integration: Connection Flow', () => {
  const senderDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_sender';
  const receiverDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_receiver';
  let invitationCode: string;
  let requestId: string;

  beforeEach(() => {
    connectionsState.clear();
    requestsState.clear();
    invitationsState.clear();
    agentRegistrationState.clear();

    // Register both agents
    agentRegistrationState.set(senderDid, { did: senderDid, status: 'ACTIVE' });
    agentRegistrationState.set(receiverDid, { did: receiverDid, status: 'ACTIVE' });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Happy Path: Full Connection Flow', () => {
    it('should complete full connection lifecycle', async () => {
      // Step 1: Create invitation
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      expect(createResult.statusCode).toBe(201);
      const createBody = JSON.parse(createResult.body);
      invitationCode = createBody.invitationCode;
      expect(invitationCode).toBeDefined();
      expect(createBody.expiresAt).toBeDefined();

      // Step 2: Send connection request
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(201);
      const sendBody = JSON.parse(sendResult.body);
      requestId = sendBody.requestId;
      expect(requestId).toBeDefined();

      // Step 3: Accept request
      const acceptEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/requests/${requestId}/accept`,
        httpMethod: 'POST',
        requestContext: {
          authorizer: { did: receiverDid },
        } as any,
      };

      const acceptResult = await acceptRequestHandler(acceptEvent as APIGatewayProxyEvent);
      expect(acceptResult.statusCode).toBe(200);
      const acceptBody = JSON.parse(acceptResult.body);
      expect(acceptBody.status).toBe('ACCEPTED');

      // Step 4: List connections for sender
      const listSenderEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections',
        httpMethod: 'GET',
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        queryStringParameters: {},
      };

      const listSenderResult = await listConnectionsHandler(
        listSenderEvent as APIGatewayProxyEvent
      );
      expect(listSenderResult.statusCode).toBe(200);
      const listSenderBody = JSON.parse(listSenderResult.body);
      expect(listSenderBody.connections).toHaveLength(1);
      expect(listSenderBody.connections[0].connectionId).toBe(receiverDid);
      expect(listSenderBody.connections[0].status).toBe('CONNECTED');

      // Step 5: List connections for receiver
      const listReceiverEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections',
        httpMethod: 'GET',
        requestContext: {
          authorizer: { did: receiverDid },
        } as any,
        queryStringParameters: {},
      };

      const listReceiverResult = await listConnectionsHandler(
        listReceiverEvent as APIGatewayProxyEvent
      );
      expect(listReceiverResult.statusCode).toBe(200);
      const listReceiverBody = JSON.parse(listReceiverResult.body);
      expect(listReceiverBody.connections).toHaveLength(1);
      expect(listReceiverBody.connections[0].connectionId).toBe(senderDid);

      // Step 6: Remove connection
      const removeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}`,
        httpMethod: 'DELETE',
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const removeResult = await removeConnectionHandler(removeEvent as APIGatewayProxyEvent);
      expect(removeResult.statusCode).toBe(200);
      const removeBody = JSON.parse(removeResult.body);
      expect(removeBody.status).toBe('DISCONNECTED');

      // Step 7: Verify connection is removed
      const listAfterRemoveEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections',
        httpMethod: 'GET',
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
        queryStringParameters: {},
      };

      const listAfterRemoveResult = await listConnectionsHandler(
        listAfterRemoveEvent as APIGatewayProxyEvent
      );
      expect(listAfterRemoveResult.statusCode).toBe(200);
      const listAfterRemoveBody = JSON.parse(listAfterRemoveResult.body);
      expect(listAfterRemoveBody.connections).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should reject self-connection', async () => {
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      expect(createResult.statusCode).toBe(201);
      const createBody = JSON.parse(createResult.body);
      const code = createBody.invitationCode;

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: senderDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(400);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.code).toBe('INVALID_REQUEST');
    });

    it('should reject duplicate request', async () => {
      // Create invitation
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      // First request
      const sendEvent1: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult1 = await sendRequestHandler(sendEvent1 as APIGatewayProxyEvent);
      expect(sendResult1.statusCode).toBe(201);

      // Duplicate request
      const sendEvent2: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult2 = await sendRequestHandler(sendEvent2 as APIGatewayProxyEvent);
      expect(sendResult2.statusCode).toBe(409);
      const sendBody2 = JSON.parse(sendResult2.body);
      expect(sendBody2.code).toBe('CONFLICT');
    });

    it('should reject non-target user accepting request', async () => {
      // Create invitation and send request
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      const reqId = JSON.parse(sendResult.body).requestId;

      // Try to accept with wrong DID
      const wrongDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ_wrong';
      const acceptEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/requests/${reqId}/accept`,
        httpMethod: 'POST',
        requestContext: {
          authorizer: { did: wrongDid },
        } as any,
      };

      const acceptResult = await acceptRequestHandler(acceptEvent as APIGatewayProxyEvent);
      expect(acceptResult.statusCode).toBe(403);
      const acceptBody = JSON.parse(acceptResult.body);
      expect(acceptBody.code).toBe('FORBIDDEN');
    });

    it('should reject expired invitation', async () => {
      // Create invitation with very short expiration
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({ expiresInSeconds: 1 }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      // Manually expire the invitation
      const invitation = invitationsState.get(code);
      if (invitation) {
        invitation.expiresAt = new Date(Date.now() - 1000).toISOString();
        invitation.ttl = Math.floor(Date.now() / 1000) - 1;
      }

      // Try to use expired invitation
      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(400);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.code).toBe('EXPIRED_INVITATION');
    });

    it('should enforce connection limit', async () => {
      // Create invitation
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      // Simulate connection limit reached
      for (let i = 0; i < 100; i++) {
        connectionsState.set(getConnectionKey(senderDid, `did:key:conn${i}`), {
          userId: senderDid,
          connectionId: `did:key:conn${i}`,
          status: 'CONNECTED',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      expect(sendResult.statusCode).toBe(429);
      const sendBody = JSON.parse(sendResult.body);
      expect(sendBody.code).toBe('TOO_MANY_CONNECTIONS');
    });

    it('should handle reject request flow', async () => {
      // Create invitation and send request
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      const reqId = JSON.parse(sendResult.body).requestId;

      // Reject request
      const rejectEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/requests/${reqId}/reject`,
        httpMethod: 'POST',
        requestContext: {
          authorizer: { did: receiverDid },
        } as any,
      };

      const rejectResult = await rejectHandler(rejectEvent as APIGatewayProxyEvent);
      expect(rejectResult.statusCode).toBe(200);
      const rejectBody = JSON.parse(rejectResult.body);
      expect(rejectBody.status).toBe('REJECTED');

      // Verify no connection was created
      const senderConnections = Array.from(connectionsState.values()).filter(
        (item) => item.userId === senderDid
      );
      expect(senderConnections).toHaveLength(0);
    });
  });

  describe('Invitation Expiration Edge Cases', () => {
    it('should accept custom expiration within limit', async () => {
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({ expiresInSeconds: 3600 }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      expect(createResult.statusCode).toBe(201);
      const createBody = JSON.parse(createResult.body);
      expect(createBody.expiresAt).toBeDefined();
    });

    it('should reject expiration exceeding maximum', async () => {
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({ expiresInSeconds: 100000 }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      expect(createResult.statusCode).toBe(400);
      const createBody = JSON.parse(createResult.body);
      expect(createBody.code).toBe('INVALID_EXPIRATION');
    });

    it('should reject negative expiration', async () => {
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({ expiresInSeconds: -100 }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      expect(createResult.statusCode).toBe(400);
      const createBody = JSON.parse(createResult.body);
      expect(createBody.code).toBe('INVALID_EXPIRATION');
    });
  });

  describe('Soft Delete', () => {
    it('should soft delete and preserve history', async () => {
      // Create and accept connection
      const createEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/invitations',
        httpMethod: 'POST',
        body: JSON.stringify({}),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const createResult = await createInvitationHandler(createEvent as APIGatewayProxyEvent);
      const code = JSON.parse(createResult.body).invitationCode;

      const sendEvent: Partial<APIGatewayProxyEvent> = {
        path: '/connections/requests',
        httpMethod: 'POST',
        body: JSON.stringify({
          toDid: receiverDid,
          invitationCode: code,
        }),
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const sendResult = await sendRequestHandler(sendEvent as APIGatewayProxyEvent);
      const reqId = JSON.parse(sendResult.body).requestId;

      const acceptEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/requests/${reqId}/accept`,
        httpMethod: 'POST',
        requestContext: {
          authorizer: { did: receiverDid },
        } as any,
      };

      await acceptRequestHandler(acceptEvent as APIGatewayProxyEvent);

      // Remove connection
      const removeEvent: Partial<APIGatewayProxyEvent> = {
        path: `/connections/${receiverDid}`,
        httpMethod: 'DELETE',
        requestContext: {
          authorizer: { did: senderDid },
        } as any,
      };

      const removeResult = await removeConnectionHandler(removeEvent as APIGatewayProxyEvent);
      expect(removeResult.statusCode).toBe(200);

      // Verify records still exist with DISCONNECTED status
      const senderConn = connectionsState.get(getConnectionKey(senderDid, receiverDid));
      expect(senderConn).toBeDefined();
      expect(senderConn?.status).toBe('DISCONNECTED');

      const receiverConn = connectionsState.get(getConnectionKey(receiverDid, senderDid));
      expect(receiverConn).toBeDefined();
      expect(receiverConn?.status).toBe('DISCONNECTED');
    });
  });
});
