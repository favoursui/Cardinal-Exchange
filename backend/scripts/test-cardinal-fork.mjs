import { createAdditionReader } from '../dist/apps/api/src/services/prepare-addition.js';
import { createRemovalReader } from '../dist/apps/api/src/services/prepare-removal.js';
// LOCAL-ONLY integration test: never accepts an external transaction endpoint.
import assert from 'node:assert/strict';
import './prepare-amm-artifacts.mjs';
import { readFileSync } from 'node:fs';
import { VenueQuotes } from '../dist/apps/api/src/services/venue-quotes.js';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseAbi } from 'viem';
import { buildApp } from '../dist/apps/api/src/app.js';
import { createQwapReader, QwapQuotes } from '../dist/apps/api/src/adapters/qwap.js';
import { createExecutionReader, swapAbi } from '../dist/apps/api/src/services/prepare-swap.js';
import { createStatusReader, TransactionTracker } from '../dist/apps/api/src/services/transaction-status.js';
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
  if (result.status !== 'success') {
    const trace = await client.request({method:'debug_traceTransaction',params:[hash,{tracer:'callTracer'}]});
    const failures=[];
    const visit=node=>{if(node.error) failures.push({to:node.to,error:node.error,gas:node.gas,gasUsed:node.gasUsed});for(const call of node.calls??[])visit(call);};
    visit(trace); console.error(JSON.stringify({localTransaction:hash,failures},null,2));
  }
  assert.equal(result.status, 'success'); return result;
};
const balance = token => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
try {
  const current = await client.getBlock();
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Math.max(Math.floor(Date.now()/1000), Number(current.timestamp) + 1)] });
  await receipt(await wallet.writeContract({ address: QWAP.tokens[0].address, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: 50n * 10n ** 18n }));
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
  const wrapped = QWAP.tokens[0].address, usdc = QWAP.tokens[1].address;
  // Obtain local test USDC through the existing DEX to seed the independent pool.
  await receipt(await wallet.writeContract({ address: wrapped, abi: erc20Abi, functionName: 'approve', args: [QWAP.router, 20n*10n**18n] }));
  await receipt(await wallet.writeContract({ address: QWAP.router, abi: swapAbi, functionName: 'swapExactTokensForTokens',
    args: [20n*10n**18n,1n,[wrapped,usdc],account,BigInt(Math.floor(Date.now()/1000)+600)] }));
  assert.ok(await balance(usdc) > 5_000_000n, 'Enough local test USDC to seed pool');
  const artifacts = JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json', import.meta.url)));
  const factoryAbi = JSON.parse(readFileSync(new URL('../node_modules/@uniswap/v2-core/build/UniswapV2Factory.json',import.meta.url))).abi;
  const routerAbi = JSON.parse(readFileSync(new URL('../node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json',import.meta.url))).abi;
  const factoryDeployment = await receipt(await wallet.deployContract({ abi: factoryAbi, bytecode: artifacts.UniswapV2Factory, args: [account] }));
  const factory = factoryDeployment.contractAddress;
  assert.ok(factory);
  const routerDeployment = await receipt(await wallet.deployContract({ abi: routerAbi, bytecode: artifacts.UniswapV2Router02, args: [factory,wrapped] }));
  const router = routerDeployment.contractAddress;
  assert.ok(router);
  assert.notEqual(factory.toLowerCase(),QWAP.factory.toLowerCase());
  assert.notEqual(router.toLowerCase(),QWAP.router.toLowerCase());
  // Force setup and simulation into the same timestamp; the first swap mines later.
  await client.request({method:'anvil_setBlockTimestampInterval',params:[0]});
  await receipt(await wallet.writeContract({address:wrapped,abi:erc20Abi,functionName:'approve',args:[router,20n*10n**18n]}));
  await receipt(await wallet.writeContract({address:usdc,abi:erc20Abi,functionName:'approve',args:[router,5_000_000n]}));
  await receipt(await wallet.writeContract({address:router,abi:routerAbi,functionName:'addLiquidity',
    args:[wrapped,usdc,20n*10n**18n,5_000_000n,20n*10n**18n,5_000_000n,account,BigInt(Math.floor(Date.now()/1000)+600)]}));
  const pair = await client.readContract({address:factory,abi:factoryAbi,functionName:'getPair',args:[wrapped,usdc]});
  const originalPair = await client.readContract({address:QWAP.factory,abi:factoryAbi,functionName:'getPair',args:[wrapped,usdc]});
  assert.notEqual(pair.toLowerCase(),originalPair.toLowerCase());
  const config = {id:'cardinal',name:'Cardinal',router,factory,
    routerHash:keccak256(await client.getCode({address:router})),factoryHash:keccak256(await client.getCode({address:factory})),
    wrappedGetter:'WETH',tokens:QWAP.tokens};
  const adapters = [new QwapQuotes(rpc),new QwapQuotes(rpc,Date.now,config)];
  const group = new VenueQuotes(rpc,adapters);
  app = await buildApp({rateLimitMax:100,quotes:group,pools:adapters,removalExecution:createRemovalReader(client),additionExecution:createAdditionReader(client),execution:createExecutionReader(client)});
  const post = async (url,payload) => {
    const result=await app.inject({method:'POST',url,payload});
    assert.equal(result.statusCode,200,result.body);return result.json();
  };
  const request = {chainId:19480,tokenIn:wrapped,tokenOut:usdc,amountIn:'100000000000000000',slippageBps:50};
  const results=[];
  for (const venue of ['cardinal','qwap']) {
    let response=await post('/v1/quotes',request);
    assert.equal(response.coverage.complete,true);
    assert.equal(response.quotes.length,2);
    assert.equal(response.quotes[0].blockHash,response.quotes[1].blockHash);
    assert.equal(response.quotes[0].venue,'qwap','Local seed intentionally gives QWAP the better rate');
    assert.equal(response.quotes[0].bestAvailablePrice,true);
    let selected=response.quotes.find(q=>q.venue===venue);
    const expectedRouter=venue==='cardinal'?router:QWAP.router;
    const approval=await post('/v1/transactions/prepare',{quoteId:selected.quoteId,wallet:account});
    assert.equal(approval.status,'approval_required');
    assert.equal(approval.spender.toLowerCase(),expectedRouter.toLowerCase());
    assert.equal(approval.amount,request.amountIn);
    await receipt(await wallet.writeContract({address:wrapped,abi:erc20Abi,functionName:'approve',args:[expectedRouter,BigInt(request.amountIn)]}));
    response=await post('/v1/quotes',request);
    selected=response.quotes.find(q=>q.venue===venue);
    const prepared=await post('/v1/transactions/prepare',{quoteId:selected.quoteId,wallet:account});
    assert.equal(prepared.status,'prepared');
    assert.equal(prepared.venue,venue);
    assert.equal(prepared.transaction.to.toLowerCase(),expectedRouter.toLowerCase());
    const before=await balance(usdc);
    const tx=prepared.transaction;
    if (venue === 'cardinal') {
      const latest=await client.getBlock();
      await client.request({method:'evm_setNextBlockTimestamp',params:[Number(latest.timestamp)+1]});
    }
    await receipt(await wallet.sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value),gas:BigInt(tx.gas)}));
    const received=await balance(usdc)-before;
    assert.ok(received>=BigInt(prepared.minimumAmountOut));
    assert.equal(await client.readContract({address:wrapped,abi:erc20Abi,functionName:'allowance',args:[account,expectedRouter]}),0n);
    results.push({selectedVenue:venue,router:expectedRouter,received:received.toString()});
  }
  // Add to the seeded pool through the exact unsigned API transaction.
  const lpBeforeDeposit = await client.readContract({address:pair,abi:erc20Abi,functionName:'balanceOf',args:[account]});
  const depositRequest = {chainId:19480,venue:'cardinal',tokenA:usdc,tokenB:wrapped,
    amountADesired:'1000000',amountBDesired:'1000000000000000000',slippageBps:50,wallet:account};
  const depositApproval = await post('/v1/liquidity/add/prepare',depositRequest);
  assert.equal(depositApproval.status,'approval_required');
  assert.equal(depositApproval.approvals.length,2);
  for (const approval of depositApproval.approvals) {
    assert.equal(approval.spender.toLowerCase(),router.toLowerCase());
    assert.equal(approval.amount,approval.token.toLowerCase()===wrapped.toLowerCase()?depositRequest.amountBDesired:depositRequest.amountADesired);
    await receipt(await wallet.writeContract({address:approval.token,abi:erc20Abi,functionName:'approve',args:[router,BigInt(approval.amount)]}));
  }
  const deposit = await post('/v1/liquidity/add/prepare',depositRequest);
  assert.equal(deposit.status,'prepared');
  assert.equal(deposit.liquidityMinimumEnforced,false);
  const depositBalances = await Promise.all([balance(deposit.token0.address),balance(deposit.token1.address)]);
  const depositTx = deposit.transaction;
  assert.equal(depositTx.to.toLowerCase(),router.toLowerCase());
  await receipt(await wallet.sendTransaction({to:depositTx.to,data:depositTx.data,value:BigInt(depositTx.value),gas:BigInt(depositTx.gas)}));
  const minted = await client.readContract({address:pair,abi:erc20Abi,functionName:'balanceOf',args:[account]})-lpBeforeDeposit;
  assert.equal(minted,BigInt(deposit.estimatedLiquidity));
  assert.ok(minted>0n);
  for (const [i,token] of [deposit.token0.address,deposit.token1.address].entries()) {
    const spent = depositBalances[i]-await balance(token);
    assert.equal(spent,BigInt(i===0?deposit.amount0:deposit.amount1));
    assert.ok(spent<=BigInt(i===0?deposit.amount0Desired:deposit.amount1Desired));
    const remaining = await client.readContract({address:token,abi:erc20Abi,functionName:'allowance',args:[account,router]});
    assert.equal(remaining,BigInt(i===0?deposit.amount0Desired:deposit.amount1Desired)-spent);
  }
  // Verify the liquidity provider can redeem its shares after trading.
  const lp=await client.readContract({address:pair,abi:erc20Abi,functionName:'balanceOf',args:[account]});
  assert.ok(lp>0n);
  const positionUrl = `/v1/pools/cardinal?tokenA=${wrapped}&tokenB=${usdc}&wallet=${account}`;
  const positionResponse = await app.inject(positionUrl);
  assert.equal(positionResponse.statusCode,200,positionResponse.body);
  const poolState = positionResponse.json();
  assert.equal(poolState.pool.toLowerCase(),pair.toLowerCase());
  assert.equal(poolState.position.lpBalance,lp.toString());
  const poolBlock = BigInt(poolState.blockNumber);
  const poolAbi = parseAbi(['function getReserves() view returns (uint112,uint112,uint32)']);
  const reserves = await client.readContract({address:pair,abi:poolAbi,functionName:'getReserves',blockNumber:poolBlock});
  const supply = await client.readContract({address:pair,abi:erc20Abi,functionName:'totalSupply',blockNumber:poolBlock});
  assert.equal(poolState.position.estimatedAmount0,(lp*reserves[0]/supply).toString());
  assert.equal(poolState.position.estimatedAmount1,(lp*reserves[1]/supply).toString());
  const removalRequest = {chainId:19480,venue:'cardinal',tokenA:wrapped,tokenB:usdc,liquidity:lp.toString(),slippageBps:50,wallet:account};
  const removalApproval = await post('/v1/liquidity/remove/prepare',removalRequest);
  assert.equal(removalApproval.status,'approval_required');
  assert.equal(removalApproval.token.toLowerCase(),pair.toLowerCase());
  assert.equal(removalApproval.spender.toLowerCase(),router.toLowerCase());
  assert.equal(removalApproval.amount,lp.toString());
  await receipt(await wallet.writeContract({address:pair,abi:erc20Abi,functionName:'approve',args:[router,lp]}));
  const beforeWrapped=await balance(wrapped),beforeUsdc=await balance(usdc);
  const removal = await post('/v1/liquidity/remove/prepare',removalRequest);
  assert.equal(removal.status,'prepared');
  const removalTx = removal.transaction;
  assert.equal(removalTx.to.toLowerCase(),router.toLowerCase());
  await receipt(await wallet.sendTransaction({to:removalTx.to,data:removalTx.data,value:BigInt(removalTx.value),gas:BigInt(removalTx.gas)}));
  const minimumWrapped = removal.token0.address.toLowerCase() === wrapped.toLowerCase() ? removal.minimumAmount0 : removal.minimumAmount1;
  const minimumUsdc = removal.token0.address.toLowerCase() === usdc.toLowerCase() ? removal.minimumAmount0 : removal.minimumAmount1;
  assert.ok(await balance(wrapped)-beforeWrapped >= BigInt(minimumWrapped));
  assert.ok(await balance(usdc)-beforeUsdc >= BigInt(minimumUsdc));
  assert.ok(await balance(wrapped)>beforeWrapped && await balance(usdc)>beforeUsdc);
  assert.equal(await client.readContract({address:pair,abi:erc20Abi,functionName:'balanceOf',args:[account]}),0n);
  const withdrawn = await app.inject(positionUrl);
  assert.equal(withdrawn.statusCode,200,withdrawn.body);
  assert.equal(withdrawn.json().position.lpBalance,'0');
  console.log(JSON.stringify({status:'passed',scope:'localhost fork only',forkBlock:metadata.forkedNetwork.forkBlockNumber,
    localDeployment:{factory,router,pair},checks:['separate Cardinal pools','real WQMS and USDC liquidity','same-block exchange quotes','price ranking without Cardinal preference','selected-venue approvals','selected-venue simulation and swaps','LP withdrawal','block-pinned LP position API','simulated unsigned withdrawal API','simulated unsigned deposit API','deposit caps and remaining allowances'],swaps:results},null,2));
} finally {
  if(app) await app.close();
  await client.request({method:'anvil_removeBlockTimestampInterval'});
  assert.equal(await client.request({method:'evm_revert',params:[snapshot]}),true,'Restore local fork');
}
