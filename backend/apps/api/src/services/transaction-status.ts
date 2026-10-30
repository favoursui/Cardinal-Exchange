import { BlockNotFoundError, createPublicClient, http, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import type { Hex, PublicClient } from 'viem';
import { CHAIN_ID } from '../../../../packages/core/src/quote.js';
import { QuoteError } from '../adapters/qwap.js';
import { QWAP } from '../adapters/qwap-registry.js';

export interface Inclusion { blockNumber: bigint; blockHash: Hex }
export interface StatusReceipt extends Inclusion { transactionHash: Hex; status: 'success' | 'reverted' }
export interface StatusTransaction { hash: Hex; blockNumber: bigint | null; blockHash: Hex | null }
export interface StatusReader {
  chainId(): Promise<number>;
  receipt(hash: Hex): Promise<StatusReceipt | null>;
  transaction(hash: Hex): Promise<StatusTransaction | null>;
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  blockHash(number: bigint): Promise<Hex | null>;
}
export function createStatusReader(client: PublicClient = createPublicClient({ transport: http(QWAP.rpcUrl, { timeout: 8000, retryCount: 0 }), cacheTime: 0 })): StatusReader {
  return {
    chainId: () => client.getChainId(),
    receipt: async hash => {
      try { return await client.getTransactionReceipt({ hash }); }
      catch (e) { if (e instanceof TransactionReceiptNotFoundError) return null; throw e; }
    },
    transaction: async hash => {
      try { return await client.getTransaction({ hash }); }
      catch (e) { if (e instanceof TransactionNotFoundError) return null; throw e; }
    },
    head: async () => {
      const block = await client.getBlock();
      if (block.number === null) throw new Error('Pending block');
      return { number: block.number, timestamp: block.timestamp };
    },
    blockHash: async blockNumber => {
      try { return (await client.getBlock({ blockNumber })).hash; }
      catch (e) { if (e instanceof BlockNotFoundError) return null; throw e; }
    },
  };
}
export const STATUS_TIMEOUT_MS = 15_000;
export const REQUIRED_CONFIRMATIONS = 3n;
const HISTORY_TTL_MS = 30 * 60 * 1000;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
function hashEqual(a: string | null, b: string) { return a?.toLowerCase() === b.toLowerCase(); }
export class TransactionTracker {
  private readonly history = new Map<Hex, { inclusion: Inclusion; observedAt: number }>();
  private readonly inFlight = new Map<Hex, Promise<Awaited<ReturnType<TransactionTracker['read']>>>>();
  constructor(private readonly rpc: StatusReader, private readonly now = Date.now) {}
  async status(rawHash: string) {
    if (!hashPattern.test(rawHash)) throw new QuoteError('INVALID_TRANSACTION_HASH', 400);
    const hash = rawHash.toLowerCase() as Hex;
    let work = this.inFlight.get(hash);
    if (!work) {
      if (this.inFlight.size >= 4) throw new QuoteError('STATUS_CAPACITY_EXCEEDED');
      work = this.read(hash).finally(() => { this.inFlight.delete(hash); });
      this.inFlight.set(hash, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QuoteError('STATUS_TIMEOUT')), STATUS_TIMEOUT_MS);
      })]);
    } catch (e) {
      if (e instanceof QuoteError) throw e;
      throw new QuoteError('STATUS_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  private async read(hash: Hex) {
    for (const [key, item] of this.history) if (this.now() - item.observedAt >= HISTORY_TTL_MS) this.history.delete(key);
    const previous = this.history.get(hash)?.inclusion;
    if (await this.rpc.chainId() !== CHAIN_ID) throw new QuoteError('CHAIN_MISMATCH');
    const head = await this.rpc.head();
    const age = BigInt(Math.floor(this.now() / 1000)) - head.timestamp;
    if (head.number < 0n || age < -15n || age > 120n) throw new QuoteError('STALE_CHAIN_STATE');
    const receipt = await this.rpc.receipt(hash);
    const base = { hash, chainId: CHAIN_ID, requiredConfirmations: REQUIRED_CONFIRMATIONS.toString(),
      finalized: false, replacementDetection: 'unsupported', observedAt: new Date(this.now()).toISOString(),
      headBlock: head.number.toString() };
    const orphan = (inclusion: Inclusion) => ({ ...base, status: 'reorged', confirmations: '0',
      blockNumber: null, blockHash: null, reorgDetected: true,
      previousInclusion: { blockNumber: inclusion.blockNumber.toString(), blockHash: inclusion.blockHash } });
    if (!receipt) {
      if (previous) {
        const canonical = await this.rpc.blockHash(previous.blockNumber);
        if (canonical && !hashEqual(canonical, previous.blockHash)) return orphan(previous);
        // Missing block/receipt alone may be a lagging RPC, not evidence of a reorg.
        throw new QuoteError('INCONSISTENT_CHAIN_STATE');
      }
      const tx = await this.rpc.transaction(hash);
      if (tx && (!hashEqual(tx.hash, hash) || tx.blockHash !== null || tx.blockNumber !== null)) throw new QuoteError('INCONSISTENT_CHAIN_STATE');
      return { ...base, status: tx ? 'pending' : 'not_found', confirmations: '0', blockNumber: null, blockHash: null, reorgDetected: false, previousInclusion: null };
    }
    if (!hashEqual(receipt.transactionHash, hash) || !hashPattern.test(receipt.blockHash) || receipt.blockNumber < 0n ||
      !['success', 'reverted'].includes(receipt.status)) throw new QuoteError('INVALID_RECEIPT');
    if (receipt.blockNumber > head.number) throw new QuoteError('INCONSISTENT_CHAIN_STATE');
    // Validate inclusion both before and after the second head read.
    const canonical = await this.rpc.blockHash(receipt.blockNumber);
    if (canonical === null || canonical === undefined) throw new QuoteError('INCONSISTENT_CHAIN_STATE');
    if (!hashEqual(canonical, receipt.blockHash)) return orphan(receipt);
    const latest = await this.rpc.head();
    const latestAge = BigInt(Math.floor(this.now() / 1000)) - latest.timestamp;
    if (latestAge < -15n || latestAge > 120n) throw new QuoteError('STALE_CHAIN_STATE');
    const lastHash = await this.rpc.blockHash(receipt.blockNumber);
    if (!lastHash || latest.number < head.number) throw new QuoteError('INCONSISTENT_CHAIN_STATE');
    if (!hashEqual(lastHash, receipt.blockHash)) return orphan(receipt);
    const confirmations = latest.number - receipt.blockNumber + 1n;
    const reorgDetected = !!previous && (!hashEqual(previous.blockHash, receipt.blockHash) || previous.blockNumber !== receipt.blockNumber);
    this.history.delete(hash);
    if (this.history.size >= 1000) this.history.delete(this.history.keys().next().value!);
    this.history.set(hash, { inclusion: { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }, observedAt: this.now() });
    return { ...base, observedAt: new Date(this.now()).toISOString(), headBlock: latest.number.toString(),
      status: receipt.status === 'reverted' ? 'reverted' : confirmations >= REQUIRED_CONFIRMATIONS ? 'confirmed' : 'confirming',
      confirmations: confirmations.toString(), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      reorgDetected, previousInclusion: previous && reorgDetected ? { blockNumber: previous.blockNumber.toString(), blockHash: previous.blockHash } : null };
  }
}
