import { createPublicClient, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, http, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { CHAIN_ID, MAX_UINT256 } from '../../../../packages/core/src/quote.js';
import { QWAP } from '../adapters/qwap-registry.js';
import { QuoteError } from '../adapters/qwap.js';
import type { QwapQuotes } from '../adapters/qwap.js';
import { QuoteStore } from './quote-store.js';

export const swapAbi = parseAbi(['function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)']);
export interface UnsignedSwap { account: Address; to: Address; data: Hex; value: bigint }
export interface ExecutionReader {
  chainId(): Promise<number>;
  balance(token: Address, owner: Address, block: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address, block: bigint): Promise<bigint>;
  simulate(tx: UnsignedSwap, block: bigint): Promise<readonly bigint[]>;
  estimateGas(tx: UnsignedSwap, block: bigint): Promise<bigint>;
  blockHash(block: bigint): Promise<Hex | null>;
}
export function createExecutionReader(client: PublicClient = createPublicClient({ transport: http(QWAP.rpcUrl, { timeout: 8000, retryCount: 0 }), cacheTime: 0 })): ExecutionReader {
  return {
    chainId: () => client.getChainId(),
    balance: (address, owner, blockNumber) => client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber }),
    allowance: (address, owner, spender, blockNumber) => client.readContract({ address, abi: erc20Abi, functionName: 'allowance', args: [owner, spender], blockNumber }),
    simulate: async (tx, blockNumber) => {
      const result = await client.call({ ...tx, blockNumber });
      if (!result.data) throw new Error('Missing simulation result');
      return decodeFunctionResult({ abi: swapAbi, functionName: 'swapExactTokensForTokens', data: result.data });
    },
    estimateGas: (tx, blockNumber) => client.estimateGas({ ...tx, blockNumber }),
    blockHash: async blockNumber => (await client.getBlock({ blockNumber })).hash,
  };
}
function samePath(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((address, i) => address.toLowerCase() === b[i]?.toLowerCase());
}
function isUint(n: bigint) { return typeof n === 'bigint' && n >= 0n && n <= MAX_UINT256; }
export const PREPARE_TIMEOUT_MS = 30_000;
export class SwapPreparer {
  private active = 0;
  constructor(private readonly store: QuoteStore, private readonly quotes: Pick<QwapQuotes, 'quote'>,
    private readonly rpc: ExecutionReader, private readonly now = Date.now) {}
  async prepare(quoteId: string, wallet: string) {
    let account: Address;
    try { account = getAddress(wallet); } catch { throw new QuoteError('INVALID_WALLET', 400); }
    if (account === zeroAddress) throw new QuoteError('INVALID_WALLET', 400);
    const original = this.store.get(quoteId);
    if (this.active >= 2) throw new QuoteError('PREPARATION_CAPACITY_EXCEEDED');
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.build(original, account, quoteId).finally(() => { this.active--; });
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QuoteError('PREPARATION_TIMEOUT')), PREPARE_TIMEOUT_MS);
      })]);
    } catch (error) {
      if (error instanceof QuoteError) throw error;
      throw new QuoteError('PREPARATION_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  private async build(original: ReturnType<QuoteStore['get']>, account: Address, quoteId: string) {
    const started = this.now();
    const fresh = await this.quotes.quote(original.request);
    if (fresh.chainId !== CHAIN_ID || fresh.venue !== original.quote.venue ||
      !samePath(fresh.path, original.quote.path) || !samePath(fresh.pools, original.quote.pools)) {
      throw new QuoteError('ROUTE_CHANGED_REQUOTE', 409);
    }
    const originalMinimum = BigInt(original.quote.minimumAmountOut);
    if (BigInt(fresh.amountOut) < originalMinimum) throw new QuoteError('PRICE_MOVED_REQUOTE', 409);
    const minimum = BigInt(fresh.minimumAmountOut) > originalMinimum ? BigInt(fresh.minimumAmountOut) : originalMinimum;
    const amount = BigInt(original.request.amountIn);
    const block = BigInt(fresh.blockNumber);
    if (await this.rpc.chainId() !== CHAIN_ID) throw new QuoteError('CHAIN_MISMATCH');
    const values = await Promise.allSettled([
      this.rpc.balance(getAddress(fresh.tokenIn), account, block),
      this.rpc.allowance(getAddress(fresh.tokenIn), account, QWAP.router, block),
    ]);
    const [balance, allowance] = values.map(value => {
      if (value.status === 'rejected') throw value.reason;
      return value.value;
    });
    if (balance === undefined || allowance === undefined || !isUint(balance) || !isUint(allowance)) throw new QuoteError('INVALID_WALLET_STATE');
    const ensureFresh = () => {
      if (this.now() >= Date.parse(fresh.expiresAt) || this.now() - started >= PREPARE_TIMEOUT_MS) throw new QuoteError('PREPARATION_EXPIRED', 409);
    };
    ensureFresh();
    if (balance < amount) throw new QuoteError('INSUFFICIENT_TOKEN_BALANCE', 422);
    if (allowance < amount) {
      // Instructions only. No approval calldata or unlimited allowance is returned.
      return { status: 'approval_required' as const, quoteId, chainId: CHAIN_ID,
        token: fresh.tokenIn, owner: account, spender: QWAP.router, amount: amount.toString(),
        currentAllowance: allowance.toString(), resetAllowanceFirst: allowance > 0n,
        refreshQuoteAfterApproval: true, transaction: null };
    }
    const deadline = BigInt(Math.floor(this.now() / 1000) + 120);
    const path = fresh.path.map(address => getAddress(address));
    const tx: UnsignedSwap = { account, to: QWAP.router, value: 0n,
      data: encodeFunctionData({ abi: swapAbi, functionName: 'swapExactTokensForTokens', args: [amount, minimum, path, account, deadline] }) };
    // Decode the exact payload we will return, rather than relying on UI descriptions.
    const decoded = decodeFunctionData({ abi: swapAbi, data: tx.data });
    if (decoded.functionName !== 'swapExactTokensForTokens' || decoded.args[0] !== amount || decoded.args[1] !== minimum ||
      !samePath(decoded.args[2], original.quote.path) || decoded.args[3] !== account || decoded.args[4] !== deadline) throw new QuoteError('TRANSACTION_INTENT_MISMATCH');
    let simulated: readonly bigint[];
    let gas: bigint;
    try {
      const results = await Promise.allSettled([this.rpc.simulate(tx, block), this.rpc.estimateGas(tx, block)]);
      const call = results[0]!, estimate = results[1]!;
      if (call.status === 'rejected' || estimate.status === 'rejected') throw new Error('Simulation failed');
      simulated = call.value; gas = estimate.value;
    } catch { throw new QuoteError('SIMULATION_FAILED', 422); }
    if (simulated.length !== path.length || simulated[0] !== amount || simulated.some(n => !isUint(n) || n === 0n) ||
      simulated.at(-1) !== BigInt(fresh.amountOut) || simulated.at(-1)! < minimum || !isUint(gas) || gas === 0n || gas > 5_000_000n) {
      throw new QuoteError('INVALID_SIMULATION');
    }
    if (await this.rpc.blockHash(block) !== fresh.blockHash) throw new QuoteError('BLOCK_REORG');
    ensureFresh();
    return { status: 'prepared' as const, quoteId, venue: fresh.venue, chainId: CHAIN_ID,
      recipient: account, amountIn: amount.toString(), quotedAmountOut: fresh.amountOut,
      minimumAmountOut: minimum.toString(), path, pools: fresh.pools,
      deadline: deadline.toString(), expiresAt: fresh.expiresAt,
      simulation: { blockNumber: fresh.blockNumber, blockHash: fresh.blockHash, gasEstimate: gas.toString() },
      transaction: { chainId: CHAIN_ID, from: account, to: tx.to, data: tx.data, value: '0', gas: ((gas * 120n + 99n) / 100n).toString() },
    };
  }
}
