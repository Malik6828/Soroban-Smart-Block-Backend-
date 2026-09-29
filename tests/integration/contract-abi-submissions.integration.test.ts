import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaRead, prismaWrite } from '../../src/db';
import {
  createContractAbiSubmission,
  publishContractAbiSubmission,
  reviewContractAbiSubmission,
} from '../../src/services/contract-abi-submissions';

const enabled = process.env.CONTRACT_ABI_INTEGRATION === '1';
const integrationDescribe = describe.skipIf(!enabled);

integrationDescribe('contract ABI submission PostgreSQL integration', () => {
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  const address = `CABI${token}`;
  const submitter = `integration-${token}`;
  const functionName = `invoke_${token}`;
  const abi = { functions: [{ name: functionName, inputs: [{ name: 'arg', type: 'i128' }] }] };
  const triggerName = `contract_abi_fail_${token}`;
  const functionSqlName = `contract_abi_fail_fn_${token}`;
  let ledgerSequence: number;
  let submissionId: string;
  let triggerCreated = false;

  beforeAll(async () => {
    ledgerSequence = 1_500_000_000 + (Number.parseInt(token.slice(0, 7), 16) % 500_000_000);
    await prismaWrite.contract.create({ data: { address } });
    await prismaWrite.ledger.create({
      data: {
        sequence: ledgerSequence,
        hash: `contract-abi-ledger-${token}`,
        closeTime: new Date(),
      },
    });
    await prismaWrite.transaction.create({
      data: {
        id: `contract-abi-tx-${token}`,
        hash: `contract-abi-hash-${token}`,
        ledgerSequence,
        ledgerCloseTime: new Date(),
        sourceAccount: `source-${token}`,
        contractAddress: address,
        functionName,
        rawXdr: 'integration-test-xdr',
        status: 'success',
      },
    });
  });

  afterAll(async () => {
    if (triggerCreated) {
      await prismaWrite.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "_contract_networks"`);
      await prismaWrite.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionSqlName}"()`);
    }
    await prismaWrite.contractAbiSubmission.deleteMany({ where: { address } });
    await prismaWrite.transaction.deleteMany({ where: { contractAddress: address } });
    await prismaWrite.contractNetwork.deleteMany({ where: { address } });
    await prismaWrite.contract.deleteMany({ where: { address } });
    if (ledgerSequence) await prismaWrite.ledger.deleteMany({ where: { sequence: ledgerSequence } });
  });

  it('replays idempotently, rolls back failed publication, and recovers on retry', async () => {
    const created = await createContractAbiSubmission(
      { address, network: 'testnet', name: 'Integration Contract', abi },
      submitter,
    );
    submissionId = created.submission.id;
    expect(created.duplicate).toBe(false);
    expect(created.submission.status).toBe('pending');

    const replays = await Promise.all(
      Array.from({ length: 8 }, () =>
        createContractAbiSubmission(
          { address, network: 'testnet', name: 'Integration Contract', abi },
          submitter,
        ),
      ),
    );
    expect(new Set(replays.map((replay) => replay.submission.id))).toEqual(new Set([submissionId]));
    expect(replays.every((replay) => replay.duplicate)).toBe(true);

    await reviewContractAbiSubmission(submissionId, 'approved', 'integration-admin', 'Reviewed');

    await prismaWrite.$executeRawUnsafe(`
      CREATE FUNCTION "${functionSqlName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.address = '${address}' THEN
          RAISE EXCEPTION 'injected contract registry write failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prismaWrite.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}" BEFORE INSERT OR UPDATE ON "_contract_networks"
      FOR EACH ROW EXECUTE FUNCTION "${functionSqlName}"()
    `);
    triggerCreated = true;

    await expect(publishContractAbiSubmission(submissionId, 'integration-admin')).rejects.toThrow(
      'injected contract registry write failure',
    );
    const afterFailure = await prismaWrite.contractAbiSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { events: true },
    });
    const registryAfterFailure = await prismaWrite.contract.findUniqueOrThrow({ where: { address } });
    expect(afterFailure.status).toBe('approved');
    expect(afterFailure.events.map((event) => event.toStatus)).toEqual(['pending', 'approved']);
    expect(registryAfterFailure.abi).toBeNull();
    expect(
      await prismaWrite.contractNetwork.findUnique({
        where: { address_network: { address, network: 'testnet' } },
      }),
    ).toBeNull();

    await prismaWrite.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "_contract_networks"`);
    await prismaWrite.$executeRawUnsafe(`DROP FUNCTION "${functionSqlName}"()`);
    triggerCreated = false;

    const published = await publishContractAbiSubmission(submissionId, 'integration-admin');
    expect(published.status).toBe('published');
    expect(published.validationLedger).toBe(ledgerSequence);
    const deployment = await prismaWrite.contractNetwork.findUniqueOrThrow({
      where: { address_network: { address, network: 'testnet' } },
    });
    expect(deployment.abiHash).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
