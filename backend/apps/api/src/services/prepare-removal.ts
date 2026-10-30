import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import type { PublicClient } from 'viem';
import { CHAIN_ID, MAX_UINT256, validateQuote } from '../../../../packages/core/src/quote.js';
import { QuoteError } from '../adapters/qwap.js';
import type { QwapQuotes } from '../adapters/qwap.js';
import { createExecutionReader, PREPARE_TIMEOUT_MS, V2_NEXT_BLOCK_GAS_BUFFER } from './prepare-swap.js';
import type { ExecutionReader } from './prepare-swap.js';

export const removalAbi = parseAbi(['function removeLiquidity(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB)']);
export interface RemovalRequest { chainId: number; venue: string; tokenA: string; tokenB: string; liquidity: string; slippageBps: number; wallet: string }
export function createRemovalReader(client: PublicClient): ExecutionReader {
  const reader = createExecutionReader(client);
  // Reuse the same client/transport policy but decode this method's return type.
  return { ...reader, simulate: async (tx, block) => {
    const result = await client.call({ ...tx, blockNumber: block });
    if (!result.data) throw new Error('Missing simulation result');
    return decodeFunctionResult({ abi: removalAbi, functionName: 'removeLiquidity', data: result.data });
  } };
}
const uint = (n: bigint) => typeof n === 'bigint' && n >= 0n && n <= MAX_UINT256;
export class RemovalPreparer {
  private active = 0;
  private readonly venues: Map<string, Pick<QwapQuotes, 'venueId' | 'pool'>>;
  constructor(adapters: readonly Pick<QwapQuotes, 'venueId' | 'pool'>[], private readonly rpc: ExecutionReader, private readonly now = Date.now) {
    this.venues = new Map(adapters.map(a => [a.venueId, a]));
    if (!adapters.length || adapters.length > 4 || this.venues.size !== adapters.length) throw new Error('Invalid removal registry');
  }
  async prepare(request: RemovalRequest) {
    if (!validateQuote({ chainId: request.chainId, tokenIn: request.tokenA, tokenOut: request.tokenB, amountIn: request.liquidity, slippageBps: request.slippageBps })) throw new QuoteError('INVALID_REMOVAL_REQUEST', 400);
    let account;
    try { account = getAddress(request.wallet); } catch { throw new QuoteError('INVALID_WALLET', 400); }
    if (account === zeroAddress) throw new QuoteError('INVALID_WALLET', 400);
    const adapter = this.venues.get(request.venue);
    if (!adapter) throw new QuoteError('UNSUPPORTED_VENUE', 422);
    if (this.active >= 2) throw new QuoteError('PREPARATION_CAPACITY_EXCEEDED');
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.build({ ...request, wallet: account }, adapter).finally(() => { this.active--; });
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QuoteError('PREPARATION_TIMEOUT')), PREPARE_TIMEOUT_MS);
      })]);
    } catch (error) {
      if (error instanceof QuoteError) throw error;
      throw new QuoteError('PREPARATION_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  private async build(request: RemovalRequest, adapter: Pick<QwapQuotes, 'venueId' | 'pool'>) {
    const started = this.now();
    const account = getAddress(request.wallet);
    const pool = await adapter.pool(request.tokenA, request.tokenB, account);
    if (pool.chainId !== CHAIN_ID || pool.venue !== request.venue || !pool.position || getAddress(pool.position.wallet) !== account ||
      ![pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].includes(request.tokenA.toLowerCase()) ||
      ![pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].includes(request.tokenB.toLowerCase())) throw new QuoteError('INVALID_POOL');
    const block = BigInt(pool.blockNumber), amount = BigInt(request.liquidity);
    const supply = BigInt(pool.totalSupply), balance = BigInt(pool.position.lpBalance);
    if (!uint(supply) || !uint(balance) || balance > supply) throw new QuoteError('INVALID_LP_STATE');
    if (amount > balance || supply === 0n) throw new QuoteError('INSUFFICIENT_LP_BALANCE', 422);
    const reserves = [BigInt(pool.reserve0), BigInt(pool.reserve1)];
    if (reserves.some(r => !uint(r) || r >= 1n << 112n)) throw new QuoteError('INVALID_RESERVES');
    const minima = reserves.map(r => (amount * r / supply) * BigInt(10000 - request.slippageBps) / 10000n);
    if (minima.some(n => n === 0n)) throw new QuoteError('AMOUNT_TOO_SMALL', 422);
    const expires = Date.parse(pool.observedAt) + 15000;
    const ensureFresh = async () => {
      if (await this.rpc.blockHash(block) !== pool.blockHash) throw new QuoteError('BLOCK_REORG');
      if (!Number.isFinite(expires) || this.now() >= expires || this.now() - started >= PREPARE_TIMEOUT_MS) throw new QuoteError('PREPARATION_EXPIRED', 409);
    };
    if (await this.rpc.chainId() !== CHAIN_ID) throw new QuoteError('CHAIN_MISMATCH');
    const allowance = await this.rpc.allowance(getAddress(pool.pool), account, pool.router, block);
    if (!uint(allowance)) throw new QuoteError('INVALID_WALLET_STATE');
    await ensureFresh();
    if (allowance < amount) return { status: 'approval_required' as const, chainId: CHAIN_ID, venue: pool.venue,
      token: pool.pool, owner: account, spender: pool.router, amount: amount.toString(), currentAllowance: allowance.toString(),
      resetAllowanceFirst: allowance > 0n, refreshPreparationAfterApproval: true, transaction: null };
    const deadline = BigInt(Math.floor(this.now() / 1000) + 120);
    const args = [getAddress(pool.token0.address), getAddress(pool.token1.address), amount, minima[0]!, minima[1]!, account, deadline] as const;
    const tx = { account, to: pool.router, value: 0n, data: encodeFunctionData({ abi: removalAbi, functionName: 'removeLiquidity', args }) };
    const decoded = decodeFunctionData({ abi: removalAbi, data: tx.data });
    if (decoded.functionName !== 'removeLiquidity' || decoded.args.some((v, i) => v !== args[i])) throw new QuoteError('TRANSACTION_INTENT_MISMATCH');
    const results = await Promise.allSettled([this.rpc.simulate(tx, block), this.rpc.estimateGas(tx, block)]);
    const simulation = results[0], estimate = results[1];
    if (simulation.status !== 'fulfilled' || estimate.status !== 'fulfilled') throw new QuoteError('SIMULATION_FAILED', 422);
    const amounts = simulation.value, gas = estimate.value;
    if (amounts.length !== 2 || amounts.some((n, i) => !uint(n) || n < minima[i]!) || !uint(gas) || gas === 0n || gas > 5_000_000n) throw new QuoteError('INVALID_SIMULATION');
    await ensureFresh();
    return { status: 'prepared' as const, chainId: CHAIN_ID, venue: pool.venue, pool: pool.pool, recipient: account,
      liquidity: amount.toString(), token0: pool.token0, token1: pool.token1,
      amount0: amounts[0]!.toString(), amount1: amounts[1]!.toString(), minimumAmount0: minima[0]!.toString(), minimumAmount1: minima[1]!.toString(),
      deadline: deadline.toString(), expiresAt: new Date(expires).toISOString(),
      simulation: { blockNumber: pool.blockNumber, blockHash: pool.blockHash, gasEstimate: gas.toString() },
      gasPolicy: { marginBps: 2000, poolBuffer: V2_NEXT_BLOCK_GAS_BUFFER.toString() },
      transaction: { chainId: CHAIN_ID, from: account, to: tx.to, data: tx.data, value: '0', gas: ((gas * 120n + 99n) / 100n + V2_NEXT_BLOCK_GAS_BUFFER).toString() } };
  }
}
