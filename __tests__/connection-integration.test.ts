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

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn((params: { TableName: string; Item: Record<string, unknown> }) => ({
        promise: jest.fn().mockImplementation(() => {
          const { TableName, Item } = params;
          if (TableName.includes('connections') && !TableName.includes('requests')) {
            const item = Item as unknown as ConnectionItem;
            connectionsState.set(getConnectionKey(item.userId, item.connectionId), item);
          } else if (TableName.includes('connection-requests')) {
            const item = Item as unknown as RequestItem;
            requestsState.set(item.requestId, item);
          } else if (TableName.includes('invitations')) {
            const item = Item as unknown as InvitationItem;
            invitationsState.set(item.invitationCode, item);
          }
          return Promise.resolve({});
        }),
      })),
      get: jest.fn((params: { TableName: string; Key: Record<string, unknown> }) => ({
        promise: jest.fn().mockImplementation(() => {
          const { TableName, Key } = params;
          if (TableName.includes('connections') && !TableName.includes('requests')) {
            const key = getConnectionKey(Key.userId as string, Key.connectionId as string);
            const item = connectionsState.get(key);
            return Promise.resolve({ Item: item });
          } else if (TableName.includes('connection-requests')) {
            const item = requestsState.get(Key.requestId as string);
            return Promise.resolve({ Item: item });
          } else if (TableName.includes('invitations')) {
            const item = invitationsState.get(Key.invitationCode as string);
            return Promise.resolve({ Item: item });
          } else if (TableName.includes('agent-registration')) {
            const item = agentRegistrationState.get(Key.did as string);
            return Promise.resolve({ Item: item });
          }
          return Promise.resolve({});
        }),
      })),
      query: jest.fn(
        (params: {
          TableName: string;
          KeyConditionExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        }) => ({
          promise: jest.fn().mockImplementation(() => {
            const { TableName, ExpressionAttributeValues } = params;
            if (TableName.includes('connections') && !TableName.includes('requests')) {
              const userId = ExpressionAttributeValues?.[':userId'] as string;
              const statusFilter = ExpressionAttributeValues?.[':status'] as string;
              let items = Array.from(connectionsState.values()).filter(
                (item) => item.userId === userId
              );
              if (statusFilter) {
                items = items.filter((item) => item.status === statusFilter);
              }
              return Promise.resolve({ Items: items, Count: items.length });
            } else if (TableName.includes('connection-requests')) {
              const toDid = ExpressionAttributeValues?.[':toDid'] as string;
              const items = Array.from(requestsState.values()).filter(
                (item) => item.toDid === toDid && item.status === 'PENDING'
              );
              return Promise.resolve({ Items: items, Count: items.length });
            } else if (TableName.includes('agent-registration')) {
              const did = ExpressionAttributeValues?.[':did'] as string;
              const items = Array.from(agentRegistrationState.values()).filter(
                (item) => item.did === did
              );
              return Promise.resolve({ Items: items, Count: items.length });
            }
            return Promise.resolve({ Items: [], Count: 0 });
          }),
        })
      ),
      update: jest.fn(
        (params: {
          TableName: string;
          Key: Record<string, unknown>;
          UpdateExpression: string;
          ExpressionAttributeValues: Record<string, unknown>;
        }) => ({
          promise: jest.fn().mockImplementation(() => {
            const { TableName, Key, ExpressionAttributeValues } = params;
            if (TableName.includes('connection-requests')) {
              const item = requestsState.get(Key.requestId as string);
              if (item) {
                item.status = ExpressionAttributeValues[':status'] as string;
                item.updatedAt = ExpressionAttributeValues[':updatedAt'] as string;
              }
            }
            return Promise.resolve({});
          }),
        })
      ),
      transactWrite: jest.fn((params: { TransactItems: Array<Record<string, unknown>> }) => ({
        promise: jest.fn().mockImplementation(() => {
          const { TransactItems } = params;
          for (const item of TransactItems) {
            if (item.Put) {
              const putItem = item.Put as { TableName: string; Item: Record<string, unknown> };
              const tableName = putItem.TableName;
              const itemData = putItem.Item;
              if (tableName.includes('connections')) {
                const conn = itemData as unknown as ConnectionItem;
                connectionsState.set(getConnectionKey(conn.userId, conn.connectionId), conn);
              } else if (tableName.includes('connection-requests')) {
                const req = itemData as unknown as RequestItem;
                requestsState.set(req.requestId, req);
              }
            }
            if (item.Update) {
              const updateItem = item.Update as {
                TableName: string;
                Key: Record<string, unknown>;
                ExpressionAttributeValues: Record<string, unknown>;
              };
              const tableName = updateItem.TableName;
              const key = updateItem.Key;
              const values = updateItem.ExpressionAttributeValues;
              if (tableName.includes('connections')) {
                const connKey = getConnectionKey(key.userId as string, key.connectionId as string);
                const conn = connectionsState.get(connKey);
                if (conn) {
                  conn.status = values[':status'] as string;
                  conn.updatedAt = values[':updatedAt'] as string;
                }
              } else if (tableName.includes('connection-requests')) {
                const req = requestsState.get(key.requestId as string);
                if (req) {
                  req.status = values[':status'] as string;
                  req.updatedAt = values[':updatedAt'] as string;
                }
              }
            }
          }
          return Promise.resolve({});
        }),
      })),
    })),
  },
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
