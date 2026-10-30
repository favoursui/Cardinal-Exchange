import { createPublicClient, http, isAddress, keccak256, parseAbi, zeroAddress } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { CHAIN_ID, MAX_UINT256, validateQuote } from '../../../../packages/core/src/quote.js';
import type { QuoteRequest } from '../../../../packages/core/src/quote.js';
import { QWAP } from './qwap-registry.js';

export const QUOTE_TIMEOUT_MS = 20_000;
const abi: Abi = parseAbi([
  'function factory() view returns (address)',
  'function WQMS() view returns (address)',
  'function getPair(address,address) view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
]);
export interface Snapshot { number: bigint; hash: Hex; timestamp: bigint }
export interface QwapReader {
  chainId(): Promise<number>;
  block(number?: bigint): Promise<Snapshot>;
  codeHash(address: Address, block: bigint): Promise<Hex | undefined>;
  read(address: Address, method: string, args: readonly unknown[], block: bigint): Promise<unknown>;
}
export function createQwapReader(): QwapReader {
  const client = createPublicClient({ transport: http(QWAP.rpcUrl, { timeout: 8000, retryCount: 0 }), cacheTime: 0 });
  return {
    chainId: () => client.getChainId(),
    block: async (number) => {
      const block = await client.getBlock(number === undefined ? {} : { blockNumber: number });
      if (block.number === null || block.hash === null) throw new Error('Pending block');
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    codeHash: async (address, blockNumber) => {
      const code = await client.getCode({ address, blockNumber });
      return code && code !== '0x' ? keccak256(code) : undefined;
    },
    read: (address, functionName, args, blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber }),
  };
}
export class QuoteError extends Error {
  constructor(public readonly code: string, public readonly status: number = 503) { super(code); }
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new QuoteError(code);
}
function same(a: unknown, b: string): boolean { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
function uint(value: unknown, max = MAX_UINT256): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value <= max;
}
// Drain each group before releasing capacity, even if one RPC call fails early.
async function settledGroup<T>(jobs: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(jobs);
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
export class QwapQuotes {
  private active = 0;
  private lastSuccess = 0;
  constructor(private readonly rpc: QwapReader, private readonly now = Date.now) {}
  ready(): boolean { return this.lastSuccess > 0 && this.now() - this.lastSuccess < 30_000; }
  async quote(request: QuoteRequest) {
    requireCondition(validateQuote(request), 'INVALID_QUOTE_REQUEST');
    const input = QWAP.tokens.find(t => same(t.address, request.tokenIn));
    const output = QWAP.tokens.find(t => same(t.address, request.tokenOut));
    if (!input || !output) throw new QuoteError('UNSUPPORTED_TOKEN', 422);
    if (this.active >= 4) throw new QuoteError('QUOTE_CAPACITY_EXCEEDED', 503);
    this.active++;
    // Keep the capacity slot until in-flight RPC work settles, even after the response deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.fetch(request, input, output).finally(() => { this.active--; });
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new QuoteError('QUOTE_TIMEOUT')), QUOTE_TIMEOUT_MS); }),
      ]);
      this.lastSuccess = this.now();
      return result;
    } catch (error) {
      this.lastSuccess = 0;
      if (error instanceof QuoteError) throw error;
      throw new QuoteError('UPSTREAM_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  private async fetch(request: QuoteRequest, input: typeof QWAP.tokens[number], output: typeof QWAP.tokens[number]) {
    const started = this.now();
    requireCondition(await this.rpc.chainId() === CHAIN_ID, 'CHAIN_MISMATCH');
    const block = await this.rpc.block();
    const age = BigInt(Math.floor(this.now() / 1000)) - block.timestamp;
    requireCondition(age >= -15n && age <= 120n, 'STALE_BLOCK');
    const read = (address: Address, method: string, args: readonly unknown[] = []) => this.rpc.read(address, method, args, block.number);
    const identities = [
      { address: QWAP.router, codeHash: QWAP.routerHash },
      { address: QWAP.factory, codeHash: QWAP.factoryHash }, input, output,
    ];
    const hashes = await settledGroup(identities.map(async ({ address, codeHash }) => {
      return await this.rpc.codeHash(address, block.number) === codeHash;
    }));
    requireCondition(hashes.every(Boolean), 'CONTRACT_IDENTITY_MISMATCH');
    const [factory, wrapped, pair] = await settledGroup([
      read(QWAP.router, 'factory'), read(QWAP.router, 'WQMS'),
      read(QWAP.factory, 'getPair', [input.address, output.address]),
    ]);
    requireCondition(same(factory, QWAP.factory) && same(wrapped, QWAP.tokens[0].address), 'CONTRACT_IDENTITY_MISMATCH');
    if (same(pair, zeroAddress)) throw new QuoteError('NO_DIRECT_POOL', 422);
    requireCondition(typeof pair === 'string' && isAddress(pair), 'INVALID_POOL');
    const [token0, token1, pairFactory, reserves, amounts] = await settledGroup([
      read(pair, 'token0'), read(pair, 'token1'), read(pair, 'factory'), read(pair, 'getReserves'),
      read(QWAP.router, 'getAmountsOut', [BigInt(request.amountIn), [input.address, output.address]]),
    ]);
    requireCondition(same(pairFactory, QWAP.factory), 'INVALID_POOL');
    const forward = same(token0, input.address) && same(token1, output.address);
    requireCondition(forward || (same(token0, output.address) && same(token1, input.address)), 'INVALID_POOL');
    requireCondition(Array.isArray(reserves) && reserves.length === 3 && uint(reserves[0], (1n << 112n)-1n) && uint(reserves[1], (1n << 112n)-1n), 'INVALID_RESERVES');
    const reserveIn = reserves[forward ? 0 : 1] as bigint;
    const reserveOut = reserves[forward ? 1 : 0] as bigint;
    requireCondition(reserveIn > 0n && reserveOut > 0n, 'INSUFFICIENT_LIQUIDITY');
    requireCondition(Array.isArray(amounts) && amounts.length === 2 && amounts[0] === BigInt(request.amountIn) && uint(amounts[1]) && amounts[1] > 0n, 'INVALID_QUOTE');
    const amountIn = BigInt(request.amountIn);
    const expected = amountIn * 997n * reserveOut / (reserveIn * 1000n + amountIn * 997n);
    requireCondition(amounts[1] === expected && expected < reserveOut, 'QUOTE_RESERVE_MISMATCH');
    const minimum = expected * BigInt(10000 - request.slippageBps) / 10000n;
    requireCondition(minimum > 0n, 'AMOUNT_TOO_SMALL');
    const confirmed = await this.rpc.block(block.number);
    requireCondition(confirmed.hash === block.hash, 'BLOCK_REORG');
    requireCondition(this.now() - started < QUOTE_TIMEOUT_MS, 'QUOTE_TIMEOUT');
    return {
      venue: 'qwap', venueName: 'QWAP', chainId: CHAIN_ID,
      tokenIn: input.address, tokenOut: output.address,
      amountIn: request.amountIn, amountOut: expected.toString(), minimumAmountOut: minimum.toString(),
      slippageBps: request.slippageBps, path: [input.address, output.address], pool: pair,
      blockNumber: block.number.toString(), blockHash: block.hash,
      quotedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 15000).toISOString(),
      executable: false, routeScope: 'direct-pool-only', gasEstimate: null,
      // Relative to reserve spot price; includes the pool's 30 bps fee. Rounded up.
      priceImpactIncludingFeeBps: Number(((amountIn * reserveOut - expected * reserveIn) * 10000n + amountIn * reserveOut - 1n) / (amountIn * reserveOut)),
      poolFeeBps: 30,
    };
  }
}
