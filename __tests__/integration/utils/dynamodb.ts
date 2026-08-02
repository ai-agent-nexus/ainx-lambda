/**
 * DynamoDB mock infrastructure for integration tests
 * Provides in-memory storage and mock implementations for DynamoDB operations
 */

// In-memory state for integration tests
export const dynamoDBState = {
  agents: new Map<string, unknown>(),
  didUniqueness: new Map<string, unknown>(),
  refreshTokens: new Map<string, unknown>(),
  nonces: new Map<string, unknown>(),
  challenges: new Map<string, unknown>(),
  tokenBlacklist: new Map<string, unknown>(),
  connections: new Map<string, unknown>(),
  connectionRequests: new Map<string, unknown>(),
  invitations: new Map<string, unknown>(),
  messages: new Map<string, unknown>(),
};

/**
 * Clear all DynamoDB state
 */
export function clearDynamoDBState(): void {
  Object.values(dynamoDBState).forEach((map) => map.clear());
}

// Track delete commands
const deleteCommands = new WeakSet<object>();

export function markAsDelete(command: unknown): void {
  if (command !== null && typeof command === 'object') {
    deleteCommands.add(command);
  }
}

function isDelete(command: unknown): boolean {
  return command !== null && typeof command === 'object' && deleteCommands.has(command);
}

// Generic mockSend that can be customized per test
export const mockSend = jest.fn();

// Mock DynamoDB client
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

// Mock DynamoDB document client with in-memory storage
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({
      send: (...args: unknown[]) => mockSend(...args),
    })),
  },
  GetCommand: jest.fn((params) => params),
  QueryCommand: jest.fn((params) => params),
  PutCommand: jest.fn((params) => params),
  UpdateCommand: jest.fn((params) => params),
  DeleteCommand: jest.fn((params) => {
    markAsDelete(params);
    return params;
  }),
  TransactWriteCommand: jest.fn((params) => params),
}));

/**
 * Create a standard mockSend implementation for agent-related tests
 */
export function createAgentMockSend(): typeof mockSend {
  return jest.fn((command: unknown) => {
    const cmd = command as {
      TableName: string;
      Key?: Record<string, unknown>;
      Item?: Record<string, unknown>;
      ExpressionAttributeValues?: Record<string, unknown>;
      ConditionExpression?: string;
    };

    if (cmd.TableName.includes('agent-registration')) {
      if (cmd.ExpressionAttributeValues?.[':did']) {
        const did = cmd.ExpressionAttributeValues[':did'] as string;
        const items: Array<Record<string, unknown>> = [];
        for (const [, item] of dynamoDBState.agents) {
          const agentItem = item as Record<string, unknown>;
          if (agentItem.did === did && agentItem.status === 'active') {
            items.push(agentItem);
          }
        }
        return Promise.resolve({ Items: items });
      }
      if (cmd.Key) {
        const did = cmd.Key.did as string;
        const item = dynamoDBState.agents.get(did);
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        dynamoDBState.agents.set(cmd.Item.did as string, cmd.Item);
        return Promise.resolve({});
      }
    }

    if (cmd.TableName.includes('did-uniqueness')) {
      if (cmd.Key) {
        const did = cmd.Key.did as string;
        const item = dynamoDBState.didUniqueness.get(did);
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        if (cmd.ConditionExpression?.includes('attribute_not_exists')) {
          if (dynamoDBState.didUniqueness.has(cmd.Item.did as string)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'ConditionalCheckFailedException';
            return Promise.reject(error);
          }
        }
        dynamoDBState.didUniqueness.set(cmd.Item.did as string, cmd.Item);
        return Promise.resolve({});
      }
    }

    if (cmd.TableName.includes('refresh-token')) {
      if (cmd.Key) {
        const token = cmd.Key.token as string;
        const item = dynamoDBState.refreshTokens.get(token);
        if (isDelete(command)) {
          dynamoDBState.refreshTokens.delete(token);
        }
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        dynamoDBState.refreshTokens.set(cmd.Item.token as string, cmd.Item);
        return Promise.resolve({});
      }
    }

    if (cmd.TableName.includes('nonce')) {
      if (cmd.Key) {
        const nonce = cmd.Key.nonce as string;
        const item = dynamoDBState.nonces.get(nonce);
        if (isDelete(command)) {
          dynamoDBState.nonces.delete(nonce);
        }
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        if (cmd.ConditionExpression?.includes('attribute_not_exists')) {
          if (dynamoDBState.nonces.has(cmd.Item.nonce as string)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'ConditionalCheckFailedException';
            return Promise.reject(error);
          }
        }
        dynamoDBState.nonces.set(cmd.Item.nonce as string, cmd.Item);
        return Promise.resolve({});
      }
    }

    return Promise.resolve({});
  });
}

/**
 * Create a standard mockSend implementation for auth-related tests
 */
export function createAuthMockSend(): typeof mockSend {
  return jest.fn((command: unknown) => {
    const cmd = command as {
      TableName: string;
      Key?: Record<string, unknown>;
      Item?: Record<string, unknown>;
      ExpressionAttributeValues?: Record<string, unknown>;
      ConditionExpression?: string;
      TransactItems?: Array<{
        Put?: { TableName: string; Item: Record<string, unknown> };
        Delete?: { TableName: string; Key: Record<string, unknown> };
      }>;
    };

    if (cmd.TransactItems) {
      for (const item of cmd.TransactItems) {
        if (item.Delete && item.Delete.TableName.includes('refresh-token')) {
          const token = item.Delete.Key.token as string;
          dynamoDBState.refreshTokens.delete(token);
        }
        if (item.Put && item.Put.TableName.includes('refresh-token')) {
          dynamoDBState.refreshTokens.set(item.Put.Item.token as string, item.Put.Item);
        }
      }
      return Promise.resolve({});
    }

    if (cmd.TableName.includes('challenge')) {
      if (cmd.Item) {
        if (cmd.ConditionExpression?.includes('attribute_not_exists')) {
          if (dynamoDBState.challenges.has(cmd.Item.did as string)) {
            const error = new Error('ConditionalCheckFailedException');
            error.name = 'ConditionalCheckFailedException';
            return Promise.reject(error);
          }
        }
        dynamoDBState.challenges.set(cmd.Item.did as string, cmd.Item);
        return Promise.resolve({});
      }
      if (cmd.Key) {
        const did = cmd.Key.did as string;
        const item = dynamoDBState.challenges.get(did);
        if (isDelete(command)) {
          dynamoDBState.challenges.delete(did);
        }
        return Promise.resolve({ Item: item });
      }
    }

    if (cmd.TableName.includes('agent-registration')) {
      if (cmd.ExpressionAttributeValues?.[':did']) {
        const did = cmd.ExpressionAttributeValues[':did'] as string;
        const items: Array<Record<string, unknown>> = [];
        for (const [, item] of dynamoDBState.agents) {
          const agentItem = item as Record<string, unknown>;
          if (agentItem.did === did && agentItem.status === 'active') {
            items.push(agentItem);
          }
        }
        return Promise.resolve({ Items: items });
      }
      if (cmd.Key) {
        const did = cmd.Key.did as string;
        const item = dynamoDBState.agents.get(did);
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        dynamoDBState.agents.set(cmd.Item.did as string, cmd.Item);
        return Promise.resolve({});
      }
    }

    if (cmd.TableName.includes('refresh-token')) {
      if (cmd.Key) {
        const token = cmd.Key.token as string;
        const item = dynamoDBState.refreshTokens.get(token);
        if (isDelete(command)) {
          dynamoDBState.refreshTokens.delete(token);
        }
        return Promise.resolve({ Item: item });
      }
      if (cmd.Item) {
        dynamoDBState.refreshTokens.set(cmd.Item.token as string, cmd.Item);
        return Promise.resolve({});
      }
      if (cmd.ExpressionAttributeValues?.[':userId']) {
        const userId = cmd.ExpressionAttributeValues[':userId'] as string;
        const tokens: Array<Record<string, unknown>> = [];
        for (const [, item] of dynamoDBState.refreshTokens) {
          const tokenItem = item as Record<string, unknown>;
          if (tokenItem.userId === userId) {
            tokens.push(tokenItem);
          }
        }
        return Promise.resolve({ Items: tokens });
      }
    }

    if (cmd.TableName.includes('token-blacklist')) {
      if (cmd.Item) {
        dynamoDBState.tokenBlacklist.set(cmd.Item.jti as string, cmd.Item);
        return Promise.resolve({});
      }
      if (cmd.Key) {
        const jti = cmd.Key.jti as string;
        const item = dynamoDBState.tokenBlacklist.get(jti);
        return Promise.resolve({ Item: item });
      }
    }

    return Promise.resolve({});
  });
}
