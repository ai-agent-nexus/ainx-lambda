import { randomUUID } from 'crypto';

/**
 * Connection status enum
 */
export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  BLOCKED = 'BLOCKED',
}

/**
 * Connection request status enum
 */
export enum ConnectionRequestStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

/**
 * Connection interface
 */
export interface Connection {
  userId: string;
  connectionId: string;
  status: ConnectionStatus;
  createdAt: string;
  updatedAt: string;
  ttl: number;
}

/**
 * Connection request interface
 */
export interface ConnectionRequest {
  requestId: string;
  fromDid: string;
  toDid: string;
  invitationCode: string;
  status: ConnectionRequestStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ttl: number;
}

/**
 * Invitation interface
 */
export interface Invitation {
  invitationCode: string;
  creatorDid: string;
  expiresAt: string;
  createdAt: string;
  ttl: number;
}

/**
 * Create invitation request
 */
export interface CreateInvitationRequest {
  expiresInSeconds?: number;
}

/**
 * Create invitation response
 */
export interface CreateInvitationResponse {
  invitationCode: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Send connection request
 */
export interface SendConnectionRequest {
  toDid: string;
  invitationCode: string;
}

/**
 * Send connection response
 */
export interface SendConnectionResponse {
  requestId: string;
  fromDid: string;
  toDid: string;
  status: ConnectionRequestStatus;
  createdAt: string;
  expiresAt: string;
}

/**
 * Connection list response
 */
export interface ConnectionListResponse {
  connections: Array<{
    connectionId: string;
    status: ConnectionStatus;
    createdAt: string;
  }>;
  nextToken?: string;
}

/**
 * Connection request list response
 */
export interface ConnectionRequestListResponse {
  requests: Array<{
    requestId: string;
    fromDid: string;
    status: ConnectionRequestStatus;
    createdAt: string;
    expiresAt: string;
  }>;
  nextToken?: string;
}

/**
 * Constants
 */
export const CONNECTION_LIMIT = 100;
export const DEFAULT_INVITATION_TTL_SECONDS = 1800; // 30 minutes
export const MAX_INVITATION_TTL_SECONDS = 86400; // 24 hours

/**
 * Generate invitation code
 */
export function generateInvitationCode(): string {
  return randomUUID();
}

/**
 * Validate invitation code format
 */
export function isValidInvitationCode(code: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(code);
}

/**
 * Calculate invitation expiration time
 */
export function calculateInvitationExpiration(expiresInSeconds?: number): {
  expiresAt: string;
  ttl: number;
} {
  const duration = Math.min(
    Math.max(expiresInSeconds || DEFAULT_INVITATION_TTL_SECONDS, 1),
    MAX_INVITATION_TTL_SECONDS
  );

  const now = new Date();
  const expiresAt = new Date(now.getTime() + duration * 1000);
  const ttl = Math.floor(expiresAt.getTime() / 1000);

  return {
    expiresAt: expiresAt.toISOString(),
    ttl,
  };
}

/**
 * Message type enum
 */
export enum MessageType {
  DIRECT = 'direct',
  GROUP = 'group',
}

/**
 * Message interface
 */
export interface Message {
  messageId: string;
  connectionId: string;
  senderDid: string;
  receiverDid: string;
  content: string;
  timestamp: string;
  messageIdempotencyKey: string;
}

/**
 * Send message request
 */
export interface SendMessageRequest {
  content: string;
}

/**
 * Send message response
 */
export interface SendMessageResponse {
  success: boolean;
  messageId: string;
}

/**
 * Message list response
 */
export interface MessageListResponse {
  messages: Array<{
    messageId: string;
    senderDid: string;
    content: string;
    timestamp: string;
  }>;
  nextToken?: string;
}

/**
 * Generate message ID
 */
export function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate idempotency key
 */
export function generateIdempotencyKey(): string {
  return `idem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validate message content
 */
export function isValidMessageContent(content: string): boolean {
  return typeof content === 'string' && content.length > 0 && content.length <= 10240;
}

/**
 * Check if invitation is expired
 */
export function isInvitationExpired(expiresAt: string): boolean {
  return new Date(expiresAt) < new Date();
}

/**
 * Generate request ID
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Validate DID format
 */
export function isValidDid(did: string): boolean {
  return did.startsWith('did:key:');
}
