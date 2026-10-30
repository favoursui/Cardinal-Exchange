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
      { address: QWAP.factory, codeHash: QWAP.factoryHash },
      ...QWAP.tokens.filter(t => same(t.address, input.address) || same(t.address, output.address) || same(t.address, QWAP.tokens[0].address)),
    ];
    const hashes = await settledGroup(identities.map(async ({ address, codeHash }) => {
      return await this.rpc.codeHash(address, block.number) === codeHash;
    }));
    requireCondition(hashes.every(Boolean), 'CONTRACT_IDENTITY_MISMATCH');
    const [factory, wrapped] = await settledGroup([
      read(QWAP.router, 'factory'), read(QWAP.router, 'WQMS'),
    ]);
    const bridge = QWAP.tokens[0].address;
    requireCondition(same(factory, QWAP.factory) && same(wrapped, bridge), 'CONTRACT_IDENTITY_MISMATCH');
    const paths: Address[][] = [[input.address, output.address]];
    if (!same(input.address, bridge) && !same(output.address, bridge)) {
      paths.push([input.address, bridge, output.address]);
    }
    const amountIn = BigInt(request.amountIn);
    const results = await Promise.allSettled(paths.map(async path => {
      const hops = await settledGroup(path.slice(0, -1).map(async (from, index) => {
        const to = path[index + 1]!;
        const pair = await read(QWAP.factory, 'getPair', [from, to]);
        if (same(pair, zeroAddress)) throw new QuoteError('NO_DIRECT_POOL', 422);
        requireCondition(typeof pair === 'string' && isAddress(pair), 'INVALID_POOL');
        const [token0, token1, pairFactory, reserves] = await settledGroup([
          read(pair, 'token0'), read(pair, 'token1'), read(pair, 'factory'), read(pair, 'getReserves'),
        ]);
        requireCondition(same(pairFactory, QWAP.factory), 'INVALID_POOL');
        const forward = same(token0, from) && same(token1, to);
        requireCondition(forward || (same(token0, to) && same(token1, from)), 'INVALID_POOL');
        requireCondition(Array.isArray(reserves) && reserves.length === 3 && uint(reserves[0], (1n << 112n)-1n) && uint(reserves[1], (1n << 112n)-1n), 'INVALID_RESERVES');
        const reserveIn = reserves[forward ? 0 : 1] as bigint;
        const reserveOut = reserves[forward ? 1 : 0] as bigint;
        requireCondition(reserveIn > 0n && reserveOut > 0n, 'INSUFFICIENT_LIQUIDITY');
        return { pool: pair, reserveIn, reserveOut };
      }));
      requireCondition(new Set(hops.map(hop => hop.pool.toLowerCase())).size === hops.length, 'INVALID_POOL');
      const amounts = await read(QWAP.router, 'getAmountsOut', [amountIn, path]);
      requireCondition(Array.isArray(amounts) && amounts.length === path.length && amounts[0] === amountIn, 'INVALID_QUOTE');
      let expected = amountIn;
      let spotNumerator = amountIn;
      let spotDenominator = 1n;
      for (const [index, hop] of hops.entries()) {
        expected = expected * 997n * hop.reserveOut / (hop.reserveIn * 1000n + expected * 997n);
        requireCondition(uint(amounts[index + 1]) && amounts[index + 1] > 0n, 'INVALID_QUOTE');
        requireCondition(amounts[index + 1] === expected && expected < hop.reserveOut, 'QUOTE_RESERVE_MISMATCH');
        spotNumerator *= hop.reserveOut;
        spotDenominator *= hop.reserveIn;
      }
      return { path, hops, expected, spotNumerator, spotDenominator };
    }));
    // Only known absent/empty pools can be skipped. RPC and integrity failures
    // invalidate the comparison rather than presenting an unchecked winner.
    const routes = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    for (const result of results) {
      if (result.status === 'rejected' && !(result.reason instanceof QuoteError &&
          ['NO_DIRECT_POOL', 'INSUFFICIENT_LIQUIDITY'].includes(result.reason.code))) throw result.reason;
    }
    if (!routes.length) {
      if (results.length === 1 && results[0]?.status === 'rejected') throw results[0].reason;
      throw new QuoteError('NO_ROUTE', 422);
    }
    routes.sort((a, b) => a.expected === b.expected ? a.path.length - b.path.length : a.expected > b.expected ? -1 : 1);
    const best = routes[0]!;
    const expected = best.expected;
    const minimum = expected * BigInt(10000 - request.slippageBps) / 10000n;
    requireCondition(minimum > 0n, 'AMOUNT_TOO_SMALL');
    const confirmed = await this.rpc.block(block.number);
    requireCondition(confirmed.hash === block.hash, 'BLOCK_REORG');
    requireCondition(this.now() - started < QUOTE_TIMEOUT_MS, 'QUOTE_TIMEOUT');
    return {
      venue: 'qwap', venueName: 'QWAP', chainId: CHAIN_ID,
      tokenIn: input.address, tokenOut: output.address,
      amountIn: request.amountIn, amountOut: expected.toString(), minimumAmountOut: minimum.toString(),
      slippageBps: request.slippageBps, path: best.path,
      pool: best.hops.length === 1 ? best.hops[0]!.pool : null,
      pools: best.hops.map(hop => hop.pool),
      routesChecked: paths.length, routesAvailable: routes.length,
      selectionBasis: 'highest-output-before-gas',
      alternatives: routes.slice(1).map(route => ({ path: route.path, pools: route.hops.map(hop => hop.pool), amountOut: route.expected.toString() })),
      blockNumber: block.number.toString(), blockHash: block.hash,
      quotedAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 15000).toISOString(),
      executable: false, routeScope: 'direct-and-via-wqms', gasEstimate: null,
      // Relative to the product of reserve spot prices; includes every hop fee. Rounded up.
      priceImpactIncludingFeeBps: Number(((best.spotNumerator - expected * best.spotDenominator) * 10000n + best.spotNumerator - 1n) / best.spotNumerator),
      poolFeeBps: 30, feeScope: 'per-hop',
    };
  }
}
