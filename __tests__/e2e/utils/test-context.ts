import axios from 'axios';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { generateValidDid } from './did';
import { getJwtToken, registerAgent, INVITATIONS_URL, REQUESTS_URL } from './auth';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INVITATIONS_TABLE_NAME = process.env.INVITATIONS_TABLE_NAME || 'ainx-invitations-sit';
const CONNECTION_REQUESTS_TABLE_NAME =
  process.env.CONNECTION_REQUESTS_TABLE_NAME || 'ainx-connection-requests-sit';
const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME || 'ainx-connections-sit';

export interface TestContext {
  sender: { did: string; signMessage: (msg: string) => string };
  receiver: { did: string; signMessage: (msg: string) => string };
  senderToken: string;
  receiverToken: string;
}

/**
 * Create a complete test context with sender, receiver, tokens, and registration
 */
export async function createTestContext(): Promise<TestContext> {
  const sender = generateValidDid();
  const receiver = generateValidDid();
  await registerAgent(sender.did, sender.signMessage);
  await registerAgent(receiver.did, receiver.signMessage);

  // Wait a bit to ensure agent registration is propagated
  await new Promise((resolve) => setTimeout(resolve, 500));

  const senderToken = await getJwtToken(sender.did, sender.signMessage);
  const receiverToken = await getJwtToken(receiver.did, receiver.signMessage);

  return { sender, receiver, senderToken, receiverToken };
}

/**
 * Create a connection between two DIDs and return tokens + connectionId
 */
export async function createConnection(
  senderDid: string,
  senderSign: (msg: string) => string,
  receiverDid: string,
  receiverSign: (msg: string) => string
): Promise<{ senderToken: string; receiverToken: string; connectionId: string }> {
  const senderToken = await getJwtToken(senderDid, senderSign);
  const receiverToken = await getJwtToken(receiverDid, receiverSign);

  const invitationResponse = await axios.post(
    INVITATIONS_URL,
    {},
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${senderToken}`,
      },
      timeout: 10000,
    }
  );

  const invitationCode = invitationResponse.data.invitationCode;

  const requestResponse = await axios.post(
    REQUESTS_URL,
    { toDid: receiverDid, invitationCode },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${senderToken}`,
      },
      timeout: 10000,
    }
  );

  const requestId = requestResponse.data.requestId;

  const acceptResponse = await axios.post(
    `${REQUESTS_URL}/${requestId}/accept`,
    {},
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${receiverToken}`,
      },
      timeout: 10000,
    }
  );

  const connectionId = acceptResponse.data.connectionId;

  return { senderToken, receiverToken, connectionId };
}

/**
 * Clean up test data from DynamoDB tables
 */
export async function cleanupTestData(): Promise<void> {
  try {
    const deletePromises: Promise<unknown>[] = [];

    const invitations = await dynamodb.send(
      new ScanCommand({
        TableName: INVITATIONS_TABLE_NAME,
        ProjectionExpression: 'invitationCode',
      })
    );

    for (const item of invitations.Items || []) {
      deletePromises.push(
        dynamodb.send(
          new DeleteCommand({
            TableName: INVITATIONS_TABLE_NAME,
            Key: { invitationCode: item.invitationCode },
          })
        )
      );
    }

    const requests = await dynamodb.send(
      new ScanCommand({
        TableName: CONNECTION_REQUESTS_TABLE_NAME,
        ProjectionExpression: 'requestId',
      })
    );

    for (const item of requests.Items || []) {
      deletePromises.push(
        dynamodb.send(
          new DeleteCommand({
            TableName: CONNECTION_REQUESTS_TABLE_NAME,
            Key: { requestId: item.requestId },
          })
        )
      );
    }

    const connections = await dynamodb.send(
      new ScanCommand({
        TableName: CONNECTIONS_TABLE_NAME,
        ProjectionExpression: 'userId,connectionId',
      })
    );

    for (const item of connections.Items || []) {
      deletePromises.push(
        dynamodb.send(
          new DeleteCommand({
            TableName: CONNECTIONS_TABLE_NAME,
            Key: {
              userId: item.userId,
              connectionId: item.connectionId,
            },
          })
        )
      );
    }

    await Promise.all(deletePromises);
  } catch (error) {
    console.warn('Cleanup error:', error);
  }
}
