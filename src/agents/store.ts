import type { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';
import type { CapabilityToken, ResourceLimits } from './types';

/** Values that may be stored in numeric/decimal columns. */
export type AgentNumeric = number | Prisma.Decimal | null;

/** Free-form JSON column value. */
export type AgentJson = Prisma.JsonValue;

export type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  ownerAddress: string;
  templateId: string;
  status: string;
  config: Record<string, unknown>;
  permissions: CapabilityToken[];
  resourceLimits: ResourceLimits;
  metadata: AgentJson;
  maxDrawdown: AgentNumeric;
  currentDrawdown: AgentNumeric;
  totalGasUsed: AgentNumeric;
  currentDayGasUsed: AgentNumeric;
  gasResetAt: Date | null;
  totalExecutions: number;
  successfulExecutions: number;
  failureCount: number;
  lastExecutionAt: Date | null;
  lastAlertAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentExecutionRow = {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  inputState: AgentJson;
  decision: AgentJson;
  outputAction: AgentJson;
  reasoning: AgentJson;
  gasUsed: AgentNumeric;
  trace: AgentJson;
  traceHash: string;
  signature: string;
  error: string | null;
  isVerified: boolean;
  verifiedBy: number;
  verifiedCount: number;
  flaggedCount: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentAlertRow = {
  id: string;
  agentId: string;
  type: string;
  severity: string;
  message: string;
  data: AgentJson;
  acknowledged: boolean;
  acknowledgedAt: Date | null;
  createdAt: Date;
};

export type AgentMessageRow = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  subject: string;
  body: AgentJson;
  signature: string | null;
  responseToId: string | null;
  status: string;
  respondedAt: Date | null;
  createdAt: Date;
};

export type AgentRegistrationRow = {
  agentId: string;
  capabilities: string[];
  pricePerCall: string | null;
  pricePerMonth: string | null;
  metadata: AgentJson;
  rating: AgentNumeric;
  totalRatings: number;
  totalJobsDone: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Populated when the registration is queried with the owning agent included. */
  agent: { id: string; name: string; status: string } | null;
};

export type AgentRatingRow = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  executionId: string | null;
  score: number;
  review: string | null;
  createdAt: Date;
};

export type AgentTemplateRow = {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author: string;
  price: AgentNumeric;
  configSchema: AgentJson;
  wasmBase64: string;
  abi: AgentJson;
  defaultPermissions: CapabilityToken[];
  defaultLimits: ResourceLimits;
  isPublished: boolean;
  downloadCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentVerificationRow = {
  id: string;
  executionId: string;
  verifierNode: string;
  status: string;
  discrepancy: AgentJson;
  signature: string;
  verifiedAt: Date | null;
  createdAt: Date;
};

/** Relation counts available on an agent queried with `_count` included. */
export type AgentRelationCounts = {
  executions: number;
  alerts: number;
  messagesSent: number;
  messagesRecv: number;
  ratingsRecv: number;
};

/** An agent row carrying its included relation counts. */
export type AgentRowWithCounts = AgentRow & { _count: AgentRelationCounts };

/** An alert row carrying the owning agent's name and template. */
export type AgentAlertWithAgent = AgentAlertRow & {
  agent: { name: string; templateId: string } | null;
};

/** An execution row carrying its agent, verifications and ratings. */
export type AgentExecutionWithRelations = AgentExecutionRow & {
  agent: { id: string; name: string; templateId: string } | null;
  verifications: AgentVerificationRow[];
  ratings: AgentRatingRow[];
};

/** Query arguments accepted by the agent delegates. */
export type AgentQueryArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  skip?: number;
  take?: number;
  cursor?: Record<string, unknown>;
  distinct?: string | Record<string, unknown>;
};

/** Mutation arguments accepted by the agent delegates. */
export type AgentWriteArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

/**
 * Delegate surface for a single agent model. The `T` type parameter overrides the
 * row shape for queries that add relations or projections.
 */
export interface AgentDelegate<TRow> {
  findMany<T = TRow>(args?: AgentQueryArgs): Promise<T[]>;
  findUnique<T = TRow>(args: AgentQueryArgs): Promise<T | null>;
  findFirst<T = TRow>(args?: AgentQueryArgs): Promise<T | null>;
  count(args?: AgentQueryArgs): Promise<number>;
  create<T = TRow>(args: AgentWriteArgs): Promise<T>;
  update<T = TRow>(args: AgentWriteArgs): Promise<T>;
  updateMany(args: AgentWriteArgs): Promise<{ count: number }>;
  delete<T = TRow>(args: AgentWriteArgs): Promise<T>;
}

export interface AgentModels {
  agent: AgentDelegate<AgentRow>;
  agentExecution: AgentDelegate<AgentExecutionRow>;
  agentAlert: AgentDelegate<AgentAlertRow>;
  agentMessage: AgentDelegate<AgentMessageRow>;
  agentRegistration: AgentDelegate<AgentRegistrationRow>;
  agentRating: AgentDelegate<AgentRatingRow>;
  agentTemplate: AgentDelegate<AgentTemplateRow>;
  agentVerification: AgentDelegate<AgentVerificationRow>;
}

// The agent models are not declared in prisma/schema.prisma, so PrismaClient has
// no generated delegate types for them. This is the single narrowing point for
// the agent subsystem; every caller goes through the typed delegates above.
const asAgentModels = (client: unknown): AgentModels => client as AgentModels;

export const agentRead: AgentModels = asAgentModels(prismaRead);
export const agentWrite: AgentModels = asAgentModels(prismaWrite);
