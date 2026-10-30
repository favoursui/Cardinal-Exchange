// LOCAL-ONLY integration test: never accepts an external transaction endpoint.
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, getAddress, http, parseAbi } from 'viem';
import { buildApp } from '../dist/apps/api/src/app.js';
import { createQwapReader, QwapQuotes } from '../dist/apps/api/src/adapters/qwap.js';
import { createExecutionReader, swapAbi } from '../dist/apps/api/src/services/prepare-swap.js';
import { QWAP } from '../dist/apps/api/src/adapters/qwap-registry.js';

const url = 'http://127.0.0.1:18545';
const chain = defineChain({ id: 19480, name: 'Local QMS fork', nativeCurrency: { name: 'QMS', symbol: 'QMS', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const client = createPublicClient({ chain, transport: http(url, { timeout: 60000, retryCount: 0 }), cacheTime: 0 });
const version = await client.request({ method: 'web3_clientVersion' });
const metadata = await client.request({ method: 'anvil_metadata' });
assert.match(version, /^anvil\//);
assert.equal(metadata.chainId, 19480);
assert.equal(metadata.forkedNetwork?.chainId, 19480, 'Must fork QMS testnet');
const accounts = await client.request({ method: 'eth_accounts' });
assert.ok(accounts.length > 0, 'Use an isolated Anvil instance with unlocked test accounts');
const account = getAddress(accounts[0]);
const wallet = createWalletClient({ chain, account, transport: http(url, { timeout: 60000, retryCount: 0 }) });
const snapshot = await client.request({ method: 'evm_snapshot' });
let app;
const receipt = async hash => {
  const result = await client.waitForTransactionReceipt({ hash, timeout: 60000, pollingInterval: 100 });
  assert.equal(result.status, 'success'); return result;
};
const balance = token => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
try {
  const current = await client.getBlock();
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(Math.floor(Date.now()/1000), Number(current.timestamp) + 1)] });
  await receipt(await wallet.writeContract({ address: QWAP.tokens[0].address, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: 5n * 10n ** 18n }));
  // Warm lazy fork state before timing the API. This doesn't bypass identity checks.
  const rpc = createQwapReader(client);
  const header = await rpc.block();
  await Promise.all([QWAP.router, QWAP.factory, ...QWAP.tokens.map(t => t.address)].map(a => rpc.codeHash(a, header.number)));
  await rpc.read(QWAP.router, 'factory', [], header.number);
  await rpc.read(QWAP.router, 'WQMS', [], header.number);
  for (const [a,b] of [[0,1],[1,2],[0,2]]) {
    const pair = await rpc.read(QWAP.factory, 'getPair', [QWAP.tokens[a].address, QWAP.tokens[b].address], header.number);
    if (pair !== '0x0000000000000000000000000000000000000000') {
      await Promise.all(['token0','token1','factory','getReserves'].map(method => rpc.read(pair, method, [], header.number)));
    }
  }
  app = await buildApp({ rateLimitMax: 100, quotes: new QwapQuotes(rpc), execution: createExecutionReader(client) });
  const post = async (route, payload) => {
    const response = await app.inject({ method: 'POST', url: route, payload });
    assert.equal(response.statusCode, 200, `${route}: ${response.body}`);
    return response.json();
  };
  const results = [];
  for (const [input, output, amount] of [[0,1,10n ** 18n],[1,2,10000n]]) {
    const request = { chainId: 19480, tokenIn: QWAP.tokens[input].address, tokenOut: QWAP.tokens[output].address, amountIn: amount.toString(), slippageBps: 50 };
    let quote = (await post('/v1/quotes', request)).quotes[0];
    const approval = await post('/v1/transactions/prepare', { quoteId: quote.quoteId, wallet: account });
    assert.equal(approval.status, 'approval_required');
    assert.equal(approval.transaction, null);
    assert.equal(approval.spender, QWAP.router);
    assert.equal(approval.amount, amount.toString());
    assert.equal(approval.resetAllowanceFirst, false);
    await receipt(await wallet.writeContract({ address: request.tokenIn, abi: erc20Abi, functionName: 'approve', args: [QWAP.router, amount] }));
    quote = (await post('/v1/quotes', request)).quotes[0];
    const prepared = await post('/v1/transactions/prepare', { quoteId: quote.quoteId, wallet: account });
    assert.equal(prepared.status, 'prepared');
    assert.deepEqual(prepared.path, quote.path);
    assert.equal(prepared.transaction.from, account);
    assert.equal(prepared.transaction.to, QWAP.router);
    assert.equal(prepared.transaction.chainId, 19480);
    if (input === 0) {
      const call = args => client.call({ account, to: QWAP.router, data: encodeFunctionData({ abi: swapAbi, functionName: 'swapExactTokensForTokens', args }) });
      await assert.rejects(call([amount, (1n << 256n)-1n, prepared.path, account, BigInt(prepared.deadline)]), /INSUFFICIENT_OUTPUT_AMOUNT/);
      await assert.rejects(call([amount, BigInt(prepared.minimumAmountOut), prepared.path, account, 1n]), /EXPIRED/);
    }
    const beforeIn = await balance(request.tokenIn), beforeOut = await balance(request.tokenOut);
    const tx = prepared.transaction;
    const mined = await receipt(await wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), gas: BigInt(tx.gas) }));
    const afterIn = await balance(request.tokenIn), afterOut = await balance(request.tokenOut);
    assert.equal(beforeIn - afterIn, amount);
    assert.ok(afterOut - beforeOut >= BigInt(prepared.minimumAmountOut));
    assert.equal(await client.readContract({ address: request.tokenIn, abi: erc20Abi, functionName: 'allowance', args: [account, QWAP.router] }), 0n);
    const sent = await client.getTransaction({ hash: mined.transactionHash });
    assert.equal(sent.input, tx.data);
    results.push({ route: prepared.path, outputReceived: (afterOut - beforeOut).toString(), gasUsed: mined.gasUsed.toString(), localBlock: mined.blockNumber.toString() });
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'localhost fork only', forkBlock: metadata.forkedNetwork.forkBlockNumber, checks: ['approval-required response','exact approvals','sender simulation','gas estimation','direct swap','multi-hop swap','minimum-output revert','expired-deadline revert','recipient balance changes','allowance consumed'], swaps: results }, null, 2));
} finally {
  if (app) await app.close();
  const reverted = await client.request({ method: 'evm_revert', params: [snapshot] });
  assert.equal(reverted, true, 'Restore local fork snapshot');
}
