import { CHAIN_ID } from '../../../../packages/core/src/quote.js';
import type { QuoteRequest } from '../../../../packages/core/src/quote.js';
import { QuoteError } from '../adapters/qwap.js';
import type { QwapQuotes, QwapReader } from '../adapters/qwap.js';
export type VenueQuote = Awaited<ReturnType<QwapQuotes['quote']>>;
export interface Comparison {
  quotes: VenueQuote[];
  coverage: { venues: string[]; availableVenues: string[]; complete: boolean; routeScope: string; failures: { venue: string; error: string }[] };
}
export type QuoteSource = Pick<QwapQuotes, 'quote' | 'ready'> & { readonly venueIds?: readonly string[]; compare?(request: QuoteRequest): Promise<Comparison> };
export const COMPARISON_TIMEOUT_MS = 30_000;
export class VenueQuotes implements QuoteSource {
  private readonly venues = new Map<string, Pick<QwapQuotes, 'venueId' | 'quote' | 'ready'>>();
  private active = 0;
  constructor(private readonly rpc: QwapReader, adapters: readonly Pick<QwapQuotes, 'venueId' | 'quote' | 'ready'>[], private readonly now = Date.now) {
    if (!adapters.length || adapters.length > 4) throw new Error('Configure between one and four venues');
    for (const adapter of adapters) {
      if (this.venues.has(adapter.venueId)) throw new Error('Duplicate venue');
      this.venues.set(adapter.venueId, adapter);
    }
  }
  ready() { return [...this.venues.values()].some(venue => venue.ready()); }
  get venueIds(): readonly string[] { return [...this.venues.keys()]; }
  async quote(request: QuoteRequest, venueId?: string) {
    if (!venueId) throw new QuoteError('VENUE_REQUIRED', 400);
    const adapter = this.venues.get(venueId);
    if (!adapter) throw new QuoteError('UNSUPPORTED_VENUE', 422);
    // Refresh only the chosen exchange; never silently substitute another.
    return adapter.quote(request, venueId);
  }
  async compare(request: QuoteRequest): Promise<Comparison> {
    if (this.active >= 4) throw new QuoteError('QUOTE_CAPACITY_EXCEEDED');
    this.active++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = this.collect(request).finally(() => { this.active--; });
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QuoteError('COMPARISON_TIMEOUT')), COMPARISON_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async collect(request: QuoteRequest): Promise<Comparison> {
    try {
      if (await this.rpc.chainId() !== CHAIN_ID) throw new QuoteError('CHAIN_MISMATCH');
      const snapshot = await this.rpc.block();
      const entries = [...this.venues];
      const outcomes = await Promise.allSettled(entries.map(([id, adapter]) => adapter.quote(request, id, snapshot)));
      const quotes: VenueQuote[] = [];
      const failures: { venue: string; error: string }[] = [];
      outcomes.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          const quote = outcome.value;
          if (quote.venue !== entries[i]![0] || quote.chainId !== CHAIN_ID || quote.blockNumber !== snapshot.number.toString() || quote.blockHash !== snapshot.hash ||
            quote.tokenIn.toLowerCase() !== request.tokenIn.toLowerCase() || quote.tokenOut.toLowerCase() !== request.tokenOut.toLowerCase() || quote.amountIn !== request.amountIn) {
            failures.push({ venue: entries[i]![0], error: 'QUOTE_CONTEXT_MISMATCH' });
          } else quotes.push(quote);
        }
        else failures.push({ venue: entries[i]![0], error: outcome.reason instanceof QuoteError ? outcome.reason.code : 'UPSTREAM_UNAVAILABLE' });
      });
      if ((await this.rpc.block(snapshot.number)).hash !== snapshot.hash) throw new QuoteError('BLOCK_REORG');
      // Other venues may have taken time to finish; never return an expired quote.
      const valid = quotes.filter(q => Date.parse(q.expiresAt) > this.now());
      for (const quote of quotes) if (!valid.includes(quote)) failures.push({ venue: quote.venue, error: 'QUOTE_EXPIRED' });
      valid.sort((a,b) => BigInt(a.amountOut) === BigInt(b.amountOut) ? a.venue.localeCompare(b.venue) : BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : 1);
      return { quotes: valid, coverage: { venues: entries.map(([id]) => id), availableVenues: valid.map(q => q.venue), complete: !failures.length, failures, routeScope: 'direct-and-via-wqms' } };
    } catch (error) {
      if (error instanceof QuoteError) throw error;
      throw new QuoteError('UPSTREAM_UNAVAILABLE');
    }
  }
}
