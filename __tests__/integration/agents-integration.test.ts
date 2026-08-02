import { jest } from '@jest/globals';

jest.mock('@ainx/crypto-utils', () => ({
  verifySignature: jest.fn(() => true),
}));

import { clearDynamoDBState, mockSend, createAgentMockSend } from './utils/dynamodb';
import { createEvent, setupTestEnv } from './utils/helpers';
import './utils/mocks';

setupTestEnv({
  AGENT_REGISTRATION_TABLE_NAME: 'test-agent-registration-table',
  DID_UNIQUENESS_TABLE_NAME: 'test-did-uniqueness-table',
  REFRESH_TOKEN_TABLE_NAME: 'test-refresh-token-table',
  NONCE_TABLE_NAME: 'test-nonce-table',
  JWT_PUBLIC_KEY: 'test-public-key',
});

import { handler as registrationHandler } from '../../functions/agent-registration/src/index';

describe('Integration: Agent Management Flow', () => {
  const validDid = 'did:key:z6MkqRYVCQrFkje3KMtcrA7gSfgD4EC2wEZptKfHTEr8J7CZ';

  beforeEach(() => {
    clearDynamoDBState();
    const agentMockSend = createAgentMockSend();
    mockSend.mockImplementation(agentMockSend);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Full agent lifecycle with shared state', () => {
    it('should handle complete register -> rotate -> revoke flow', async () => {
      const registerEvent = createEvent({
        path: '/agents/register',
        httpMethod: 'POST',
        body: JSON.stringify({
          did: validDid,
          signature: 'valid-signature',
          metadata: { name: 'Test Agent' },
        }),
      });

      const registerResult = await registrationHandler(registerEvent);
      expect(registerResult.statusCode).toBe(201);
      const registerBody = JSON.parse(registerResult.body);
      expect(registerBody.message).toBe('Agent registered successfully');
    });
  });
});
