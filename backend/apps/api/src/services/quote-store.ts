import { randomUUID } from 'node:crypto';
import type { QwapQuotes } from '../adapters/qwap.js';
import { QuoteError } from '../adapters/qwap.js';
import type { QuoteRequest } from '../../../../packages/core/src/quote.js';
export type StoredQuote = Awaited<ReturnType<QwapQuotes['quote']>>;
export class QuoteStore {
  private readonly entries = new Map<string, { request: QuoteRequest; quote: StoredQuote }>();
  constructor(private readonly now = Date.now, private readonly capacity = 1000) {}
  put(request: QuoteRequest, quote: StoredQuote): string {
    for (const [id, item] of this.entries) if (Date.parse(item.quote.expiresAt) <= this.now()) this.entries.delete(id);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID();
    this.entries.set(id, structuredClone({ request, quote }));
    return id;
  }
  get(id: string) {
    const item = this.entries.get(id);
    if (!item || Date.parse(item.quote.expiresAt) <= this.now()) {
      this.entries.delete(id);
      throw new QuoteError('QUOTE_EXPIRED_OR_UNKNOWN', 409);
    }
    return structuredClone(item);
  }
}
