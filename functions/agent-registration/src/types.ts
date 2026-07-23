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

export interface AgentRegistrationError {
  error: string;
  code: string;
}

export interface DynamoDBAgentItem {
  did: string;
  signature: string;
  metadata: Record<string, unknown>;
  registeredAt: string;
  ttl: number;
}
