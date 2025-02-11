import {
  expect,
  deposit,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  getLastBlockTime,
  signForSpeedUp,
} from "./utils";
import { lastSpyLogIncludes, createSpyLogger, deployConfigStore, deployAndConfigureHubPool, winston } from "./utils";
import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId } from "./utils";
import { originChainId, sinon, toBNWei } from "./utils";
import { amountToLp, defaultTokenConfig } from "./constants";
import { SpokePoolClient, HubPoolClient, AcrossConfigStoreClient, MultiCallerClient } from "../src/clients";
import { TokenClient, ProfitClient } from "../src/clients";
import { MockInventoryClient } from "./mocks";

import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig"; // Tested

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, configStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spy: sinon.SinonSpy, spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };
let configStoreClient: AcrossConfigStoreClient, hubPoolClient: HubPoolClient, tokenClient: TokenClient;
let relayerInstance: Relayer;
let multiCallerClient: MultiCallerClient, profitClient: ProfitClient;

describe("Relayer: Check for Unfilled Deposits and Fill", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spy, spyLogger } = createSpyLogger());
    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    configStoreClient = new AcrossConfigStoreClient(spyLogger, configStore, hubPoolClient);

    multiCallerClient = new MultiCallerClient(spyLogger);

    spokePoolClient_1 = new SpokePoolClient(spyLogger, spokePool_1.connect(relayer), configStoreClient, originChainId);
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      configStoreClient,
      destinationChainId
    );
    spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new ProfitClient(spyLogger, hubPoolClient, spokePoolClients, true, []); // Set relayer discount to 100%.
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
      },
      {
        relayerTokens: [],
        relayerDestinationChains: [],
      } as RelayerConfig
    );

    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2], null, 10);

    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);
    await configStore.updateTokenConfig(l1Token.address, defaultTokenConfig);

    await updateAllClients();
  });

  it("Correctly fetches single unfilled deposit and fills it", async function () {
    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "Multicall batch sent")).to.be.true;
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
    expect(fillEvents2.length).to.equal(1);
    expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
    expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
    expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
    expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
    expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
    expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);
    expect(fillEvents2[0].args.appliedRelayerFeePct).to.equal(deposit1.relayerFeePct);

    // There should be no fill events on the origin spoke pool.
    expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("Uses new relayer fee pct if depositor sped it up", async function () {
    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const newRelayerFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit1, newRelayerFeePct);
    await spokePool_1.speedUpDeposit(depositor.address, newRelayerFeePct, deposit1.depositId, speedUpSignature);
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

    const tx = await multiCallerClient.executeTransactionQueue();
    expect(lastSpyLogIncludes(spy, "Multicall batch sent")).to.be.true;
    expect(tx.length).to.equal(1); // There should have been exactly one transaction.

    // Check the state change happened correctly on the smart contract. There should be exactly one fill on spokePool_2.
    const fillEvents2 = await spokePool_2.queryFilter(spokePool_2.filters.FilledRelay());
    expect(fillEvents2.length).to.equal(1);
    expect(fillEvents2[0].args.depositId).to.equal(deposit1.depositId);
    expect(fillEvents2[0].args.amount).to.equal(deposit1.amount);
    expect(fillEvents2[0].args.destinationChainId).to.equal(Number(deposit1.destinationChainId));
    expect(fillEvents2[0].args.originChainId).to.equal(Number(deposit1.originChainId));
    expect(fillEvents2[0].args.relayerFeePct).to.equal(deposit1.relayerFeePct);
    expect(fillEvents2[0].args.depositor).to.equal(deposit1.depositor);
    expect(fillEvents2[0].args.recipient).to.equal(deposit1.recipient);

    // This specific line differs from the above test: the emitted event's appliedRelayerFeePct is
    // now !== relayerFeePct.
    expect(fillEvents2[0].args.appliedRelayerFeePct).to.equal(newRelayerFeePct);

    // There should be no fill events on the origin spoke pool.
    expect((await spokePool_1.queryFilter(spokePool_1.filters.FilledRelay())).length).to.equal(0);

    // Re-run the execution loop and validate that no additional relays are sent.
    multiCallerClient.clearTransactionQueue();
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0); // no Transactions to send.
    expect(lastSpyLogIncludes(spy, "No unfilled deposits")).to.be.true;
  });

  it("Shouldn't double fill a deposit", async function () {
    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Filling deposit")).to.be.true;
    expect(multiCallerClient.transactionCount()).to.equal(1); // One transaction, filling the one deposit.

    // The first fill is still pending but if we rerun the relayer loop, it shouldn't try to fill a second time.
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update(), hubPoolClient.update()]);
    await relayerInstance.checkForUnfilledDepositsAndFill();
    // Only still 1 transaction.
    expect(multiCallerClient.transactionCount()).to.equal(1); // no Transactions to send.
  });

  it("Skip unwhitelisted chains", async function () {
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient,
        tokenClient,
        profitClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(),
      },
      {
        relayerTokens: [],
        relayerDestinationChains: [originChainId],
      } as RelayerConfig
    );

    // Deposit is not on a whitelisted destination chain so relayer shouldn't fill it.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    // Check that no transaction was sent.
    await updateAllClients();
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(lastSpyLogIncludes(spy, "Skipping deposit for unsupported destination chain")).to.be.true;
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await configStoreClient.update();
  await tokenClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
