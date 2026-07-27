export interface AgentRegistrationRequest {
  did: string;
  signature: string;
  metadata: Record<string, unknown>;
}

export interface AgentRegistrationResponse {
  message: string;
  did: string;
  registeredAt: string;
  ttl: number;
}

export interface RotateKeyRequest {
  oldDid: string;
  newDid: string;
  signature: string;
  timestamp: number;
  nonce: string;
}

export interface RotateKeyResponse {
  message: string;
  did: string;
  updatedAt: string;
}

export interface AgentRegistrationError {
  error: string;
  code: string;
}

export interface DynamoDBAgentItem {
  userId: string;
  did: string;
  status: 'active' | 'revoked';
  publicKey: string;
  metadata: Record<string, unknown>;
  didHistory: Array<{
    did: string;
    revokedAt: string | null;
    reason: string | null;
  }>;
  registeredAt: string;
  updatedAt: string;
  ttl: number;
}
