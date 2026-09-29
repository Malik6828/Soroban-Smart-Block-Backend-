import type { Prisma } from '@prisma/client';
import { prismaRead, prismaWrite } from '../db';

/**
 * Typed access layer for the sandbox tables.
 *
 * `src/sandbox/runtime.ts` persists the full sandbox runtime document (ledger
 * block, accounts, contracts, traces) but the sandbox models in
 * `prisma/schema.prisma` only declare a subset of the columns the runtime uses.
 * Declaring the row shapes here keeps the runtime's state/meter/opcode
 * boundaries explicit and gives every call site a concrete result type instead
 * of `any`.
 */

export type SandboxDecimalLike = string | number | Prisma.Decimal;

export type SandboxSessionRow = {
  id: string;
  userId: string | null;
  status: string;
  state: Prisma.InputJsonValue | null;
  context: Prisma.InputJsonValue | null;
  ledgerSequence: number;
  ledgerTimestamp: Date;
  networkPassphrase: string;
  maxContractSize: number;
  maxCpuInsn: number;
  maxMemBytes: number;
  seed: string;
  lastAccessed: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SandboxAccountRow = {
  id: string;
  sessionId: string;
  publicKey: string;
  label: string | null;
  balance: string;
  sequenceNumber: number;
  isPreFunded: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SandboxContractRow = {
  id: string;
  sessionId: string;
  contractId: string;
  name: string | null;
  wasmHash: string;
  deployerAccount: string;
  sourceContract: string | null;
  templateId: string | null;
  deployedAt: Date;
  lastCalledAt: Date | null;
  totalCalls: number;
  abi: Prisma.InputJsonValue | null;
  state: Prisma.InputJsonValue | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SandboxCallRow = {
  id: string;
  sessionId: string;
  contractId: string | null;
  functionName: string;
  args: Prisma.InputJsonValue | null;
  sourceAccount: string | null;
  success: boolean;
  result: Prisma.InputJsonValue | null;
  error: string | null;
  events: Prisma.InputJsonValue | null;
  cpuInsnUsed: number;
  memBytesUsed: number;
  readBytes: number;
  writeBytes: number;
  callIndex: number;
  createdAt: Date;
};

export type SandboxSnapshotRow = {
  id: string;
  sessionId: string;
  name: string | null;
  state: Prisma.InputJsonValue | null;
  createdAt: Date;
};

export type SandboxShareRow = {
  id: string;
  sessionId: string;
  shareId: string;
  viewOnly: boolean | null;
  snapshotState: Prisma.InputJsonValue | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export type SandboxCiRunRow = {
  id: string;
  sessionId: string | null;
  status: string;
  steps: Prisma.InputJsonValue | null;
  logs: Prisma.InputJsonValue | null;
  result: Prisma.InputJsonValue | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type FuzzRunRow = {
  id: string;
  sessionId: string;
  contractId: string | null;
  status: string;
  strategies: Prisma.InputJsonValue | null;
  totalIterations: number;
  uniqueFindings: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export type FuzzFindingRow = {
  id: string;
  fuzzRunId: string;
  severity: string;
  title: string;
  description: string | null;
  callSequence: Prisma.InputJsonValue | null;
  stateDump: Prisma.InputJsonValue | null;
  reproducible: boolean;
  createdAt: Date;
};

export type SandboxTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  wasmBase64: string | null;
  abi: Prisma.InputJsonValue | null;
  defaultArgs: Prisma.InputJsonValue | null;
  deploymentGuide: string | null;
  version: string | null;
  author: string | null;
};

export type SandboxQueryArgs = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  skip?: number;
  take?: number;
  cursor?: Record<string, unknown>;
};

export type SandboxWriteArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

/** Arguments for `createMany`, whose `data` is a list of create inputs. */
export type SandboxCreateManyArgs = {
  where?: Record<string, unknown>;
  data?: readonly unknown[];
};

/** Arguments for `upsert`, which takes separate create and update payloads. */
export type SandboxUpsertArgs = {
  where: Record<string, unknown>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/**
 * Delegate surface for a single sandbox model. The `T` parameter overrides the
 * row shape for projections that narrow or extend the base row.
 */
export interface SandboxDelegate<TRow> {
  findMany<T = TRow>(args?: SandboxQueryArgs): Promise<T[]>;
  findUnique<T = TRow>(args: SandboxQueryArgs): Promise<T | null>;
  findFirst<T = TRow>(args?: SandboxQueryArgs): Promise<T | null>;
  count(args?: SandboxQueryArgs): Promise<number>;
  createMany(args: SandboxCreateManyArgs): Promise<{ count: number }>;
  create<T = TRow>(args: SandboxWriteArgs): Promise<T>;
  update<T = TRow>(args: SandboxWriteArgs): Promise<T>;
  upsert<T = TRow>(args: SandboxUpsertArgs): Promise<T>;
  updateMany(args: SandboxWriteArgs): Promise<{ count: number }>;
  delete<T = TRow>(args: SandboxWriteArgs): Promise<T>;
  deleteMany(args: SandboxQueryArgs): Promise<{ count: number }>;
}

export interface SandboxModels {
  sandboxSession: SandboxDelegate<SandboxSessionRow>;
  sandboxAccount: SandboxDelegate<SandboxAccountRow>;
  sandboxContract: SandboxDelegate<SandboxContractRow>;
  sandboxCall: SandboxDelegate<SandboxCallRow>;
  sandboxSnapshot: SandboxDelegate<SandboxSnapshotRow>;
  sandboxShare: SandboxDelegate<SandboxShareRow>;
  sandboxCiRun: SandboxDelegate<SandboxCiRunRow>;
  fuzzRun: SandboxDelegate<FuzzRunRow>;
  fuzzFinding: SandboxDelegate<FuzzFindingRow>;
  contractTemplate: SandboxDelegate<SandboxTemplateRow>;
}

/**
 * The sandbox models are declared in prisma/schema.prisma without every column
 * the runtime writes, so PrismaClient's generated delegate types reject the
 * extra fields. This is the single narrowing point for the sandbox subsystem.
 */
const asSandboxModels = (client: unknown): SandboxModels => client as SandboxModels;

type Transactional = {
  $transaction<T>(operations: Array<Promise<unknown>>): Promise<T[]>;
};

export const sandboxRead: SandboxModels = asSandboxModels(prismaRead);
export const sandboxWrite: SandboxModels = asSandboxModels(prismaWrite);

export const sandboxTransaction = prismaWrite as unknown as Transactional;
