import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import type { PublicClient } from 'viem';
import { CHAIN_ID, MAX_UINT256, validateQuote } from '../../../../packages/core/src/quote.js';
import { QuoteError } from '../adapters/qwap.js';
import type { QwapQuotes } from '../adapters/qwap.js';
import { createExecutionReader, PREPARE_TIMEOUT_MS, V2_NEXT_BLOCK_GAS_BUFFER } from './prepare-swap.js';
import type { ExecutionReader } from './prepare-swap.js';

export const additionAbi = parseAbi(['function addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint256 amountA,uint256 amountB,uint256 liquidity)']);
export interface AdditionRequest { chainId: number; venue: string; tokenA: string; tokenB: string; amountADesired: string; amountBDesired: string; slippageBps: number; wallet: string }
export function createAdditionReader(client: PublicClient): ExecutionReader {
  const reader = createExecutionReader(client);
  // Reuse the same client/transport policy but decode this method's return type.
  return { ...reader, simulate: async (tx, block) => {
    const result = await client.call({ ...tx, blockNumber: block });
    if (!result.data) throw new Error('Missing simulation result');
    return decodeFunctionResult({ abi: additionAbi, functionName: 'addLiquidity', data: result.data });
  } };
}
const uint = (n: bigint) => typeof n === 'bigint' && n >= 0n && n <= MAX_UINT256;
export class AdditionPreparer {
  private active = 0;
  private readonly venues: Map<string, Pick<QwapQuotes, 'venueId' | 'pool'>>;
  constructor(adapters: readonly Pick<QwapQuotes, 'venueId' | 'pool'>[], private readonly rpc: ExecutionReader, private readonly now = Date.now) {
    this.venues = new Map(adapters.map(a => [a.venueId, a]));
    if (!adapters.length || adapters.length > 4 || this.venues.size !== adapters.length) throw new Error('Invalid addition registry');
  }
  async prepare(request: AdditionRequest) {
    if (!validateQuote({ chainId: request.chainId, tokenIn: request.tokenA, tokenOut: request.tokenB, amountIn: request.amountADesired, slippageBps: request.slippageBps }) || !/^[1-9][0-9]{0,77}$/.test(request.amountBDesired) || BigInt(request.amountBDesired) > MAX_UINT256) throw new QuoteError('INVALID_ADDITION_REQUEST', 400);
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
  private async build(request: AdditionRequest, adapter: Pick<QwapQuotes, 'venueId' | 'pool'>) {
    const started = this.now();
    const account = getAddress(request.wallet);
    const pool = await adapter.pool(request.tokenA, request.tokenB, account);
    if (pool.chainId !== CHAIN_ID || pool.venue !== request.venue || !pool.position || getAddress(pool.position.wallet) !== account ||
      ![pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].includes(request.tokenA.toLowerCase()) ||
      ![pool.token0.address.toLowerCase(), pool.token1.address.toLowerCase()].includes(request.tokenB.toLowerCase())) throw new QuoteError('INVALID_POOL');
    const block = BigInt(pool.blockNumber);
    const supply = BigInt(pool.totalSupply);
    const reserves = [BigInt(pool.reserve0), BigInt(pool.reserve1)] as const;
    if (!uint(supply) || reserves.some(r => !uint(r) || r >= 1n << 112n)) throw new QuoteError('INVALID_POOL');
    if (supply === 0n || reserves.some(r => r === 0n)) throw new QuoteError('POOL_INITIALIZATION_UNSUPPORTED', 422);
    const forward = pool.token0.address.toLowerCase() === request.tokenA.toLowerCase();
    const desired = (forward ? [BigInt(request.amountADesired), BigInt(request.amountBDesired)] : [BigInt(request.amountBDesired), BigInt(request.amountADesired)]) as [bigint, bigint];
    // Match Router02's canonical token0/token1 input ordering and integer rounding.
    const optimal1 = desired[0] * reserves[1] / reserves[0];
    const expected: [bigint, bigint] = optimal1 <= desired[1]
      ? [desired[0], optimal1] : [desired[1] * reserves[0] / reserves[1], desired[1]];
    if (expected.some((n, i) => n === 0n || n > desired[i]!)) throw new QuoteError('AMOUNT_TOO_SMALL', 422);
    if (expected.some((n, i) => n + reserves[i]! >= 1n << 112n)) throw new QuoteError('POOL_RESERVE_OVERFLOW', 422);
    const minima = expected.map(n => n * BigInt(10000 - request.slippageBps) / 10000n);
    if (minima.some(n => n === 0n)) throw new QuoteError('AMOUNT_TOO_SMALL', 422);
    const expires = Date.parse(pool.observedAt) + 15000;
    const ensureFresh = async () => {
      if (await this.rpc.blockHash(block) !== pool.blockHash) throw new QuoteError('BLOCK_REORG');
      if (!Number.isFinite(expires) || this.now() >= expires || this.now() - started >= PREPARE_TIMEOUT_MS) throw new QuoteError('PREPARATION_EXPIRED', 409);
    };
    if (await this.rpc.chainId() !== CHAIN_ID) throw new QuoteError('CHAIN_MISMATCH');
    const tokens = [pool.token0.address, pool.token1.address];
    // Drain all RPC work before the capacity slot can be released.
    const reads = await Promise.allSettled(tokens.flatMap(token => [
      this.rpc.balance(getAddress(token), account, block), this.rpc.allowance(getAddress(token), account, pool.router, block),
    ]));
    const values = reads.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
    if (values.some(n => !uint(n))) throw new QuoteError('INVALID_WALLET_STATE');
    if (desired.some((n, i) => values[i * 2]! < n)) throw new QuoteError('INSUFFICIENT_TOKEN_BALANCE', 422);
    await ensureFresh();
    const approvals = tokens.flatMap((token, i) => values[i * 2 + 1]! < desired[i]! ? [{
      token, owner: account, spender: pool.router, amount: desired[i]!.toString(), currentAllowance: values[i * 2 + 1]!.toString(),
      resetAllowanceFirst: values[i * 2 + 1]! > 0n,
    }] : []);
    if (approvals.length) return { status: 'approval_required' as const, chainId: CHAIN_ID, venue: pool.venue,
      approvals, refreshPreparationAfterApproval: true, transaction: null };
    const deadline = BigInt(Math.floor(this.now() / 1000) + 120);
    const args = [getAddress(pool.token0.address), getAddress(pool.token1.address), desired[0], desired[1], minima[0]!, minima[1]!, account, deadline] as const;
    const tx = { account, to: pool.router, value: 0n, data: encodeFunctionData({ abi: additionAbi, functionName: 'addLiquidity', args }) };
    const decoded = decodeFunctionData({ abi: additionAbi, data: tx.data });
    if (decoded.functionName !== 'addLiquidity' || decoded.args.some((v, i) => v !== args[i])) throw new QuoteError('TRANSACTION_INTENT_MISMATCH');
    const results = await Promise.allSettled([this.rpc.simulate(tx, block), this.rpc.estimateGas(tx, block)]);
    const simulation = results[0], estimate = results[1];
    if (simulation.status !== 'fulfilled' || estimate.status !== 'fulfilled') throw new QuoteError('SIMULATION_FAILED', 422);
    const amounts = simulation.value, gas = estimate.value;
    if (amounts.length !== 3 || amounts.some(n => !uint(n) || n === 0n) || amounts[0] !== expected[0] || amounts[1] !== expected[1] || !uint(gas) || gas === 0n || gas > 5_000_000n) throw new QuoteError('INVALID_SIMULATION');
    await ensureFresh();
    return { status: 'prepared' as const, chainId: CHAIN_ID, venue: pool.venue, pool: pool.pool, recipient: account,
      estimatedLiquidity: amounts[2]!.toString(), liquidityMinimumEnforced: false, amount0Desired: desired[0].toString(), amount1Desired: desired[1].toString(), token0: pool.token0, token1: pool.token1,
      amount0: amounts[0]!.toString(), amount1: amounts[1]!.toString(), minimumAmount0: minima[0]!.toString(), minimumAmount1: minima[1]!.toString(),
      deadline: deadline.toString(), expiresAt: new Date(expires).toISOString(),
      simulation: { blockNumber: pool.blockNumber, blockHash: pool.blockHash, gasEstimate: gas.toString() },
      gasPolicy: { marginBps: 2000, poolBuffer: V2_NEXT_BLOCK_GAS_BUFFER.toString() },
      transaction: { chainId: CHAIN_ID, from: account, to: tx.to, data: tx.data, value: '0', gas: ((gas * 120n + 99n) / 100n + V2_NEXT_BLOCK_GAS_BUFFER).toString() } };
  }
}
