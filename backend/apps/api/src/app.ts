import { AdditionPreparer } from './services/prepare-addition.js';
import type { AdditionRequest } from './services/prepare-addition.js';
import { RemovalPreparer } from './services/prepare-removal.js';
import type { RemovalRequest } from './services/prepare-removal.js';
import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { CHAIN_ID, validateQuote } from '../../../packages/core/src/quote.js';
import type { QuoteRequest } from '../../../packages/core/src/quote.js';
import { QuoteError } from './adapters/qwap.js';
import type { QwapQuotes } from './adapters/qwap.js';
import type { QuoteSource } from './services/venue-quotes.js';
import { QWAP } from './adapters/qwap-registry.js';
import { QuoteStore } from './services/quote-store.js';
import { SwapPreparer } from './services/prepare-swap.js';
import type { ExecutionReader } from './services/prepare-swap.js';
import type { TransactionTracker } from './services/transaction-status.js';
export async function buildApp(options: { logger?: boolean; rateLimitMax?: number; quotes?: QuoteSource; pools?: readonly Pick<QwapQuotes, 'venueId' | 'pool'>[]; execution?: ExecutionReader; removalExecution?: ExecutionReader; additionExecution?: ExecutionReader; tracker?: TransactionTracker; now?: () => number } = {}) {
  const pools = new Map((options.pools ?? []).map(adapter => [adapter.venueId, adapter]));
  if (pools.size !== (options.pools?.length ?? 0) || pools.size > 4) throw new Error('Invalid pool adapter registry');
  if (options.execution && !options.quotes) throw new Error('Transaction preparation requires quotes');
  const addition = options.additionExecution ? new AdditionPreparer(options.pools ?? [], options.additionExecution, options.now) : undefined;
  const removal = options.removalExecution ? new RemovalPreparer(options.pools ?? [], options.removalExecution, options.now) : undefined;
  const store = new QuoteStore(options.now);
  const preparer = options.execution && options.quotes ? new SwapPreparer(store, options.quotes, options.execution, options.now) : undefined;
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false, bodyLimit: 4096,
    requestTimeout: 10000, connectionTimeout: 10000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: options.rateLimitMax ?? 60, timeWindow: '1 minute' });
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.setErrorHandler((error, request, reply) => {
    const err = error as { statusCode?: number };
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    request.log.warn({ status, requestId: request.id }, 'Request failed');
    void reply.code(status).send({ error: status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED' });
  });
  app.get('/health/live', async () => ({ status: 'ok', chainId: CHAIN_ID }));
  app.get('/health/ready', async (_request, reply) => options.quotes?.ready()
    ? { status: 'ok', scope: 'read-only-quotes' }
    : reply.code(503).send({ status: 'not_ready', reason: options.quotes ? 'NO_RECENT_SUCCESSFUL_QUOTE' : 'NO_VERIFIED_LIQUIDITY_ADAPTERS' }));
  app.get('/v1/tokens', async () => ({ chainId: CHAIN_ID, tokens: QWAP.tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals, testnet: true })) }));
  app.get<{ Params: { venue: string }; Querystring: { tokenA: string; tokenB: string; wallet?: string } }>('/v1/pools/:venue', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', additionalProperties: false, required: ['venue'], properties: { venue: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' } } },
      querystring: { type: 'object', additionalProperties: false, required: ['tokenA', 'tokenB'], properties: {
        tokenA: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, tokenB: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
      } },
    },
  }, async (request, reply) => {
    if (!pools.size) return reply.code(503).send({ error: 'POOL_READS_DISABLED' });
    const adapter = pools.get(request.params.venue);
    if (!adapter) return reply.code(422).send({ error: 'UNSUPPORTED_VENUE' });
    try { return await adapter.pool(request.query.tokenA, request.query.tokenB, request.query.wallet); }
    catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post<{ Body: QuoteRequest }>('/v1/quotes', {
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['chainId', 'tokenIn', 'tokenOut', 'amountIn', 'slippageBps'],
      properties: {
        chainId: { type: 'integer', const: CHAIN_ID },
        tokenIn: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        tokenOut: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        amountIn: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' },
        slippageBps: { type: 'integer', minimum: 0, maximum: 500 },
      },
    } },
  }, async (request, reply) => {
    if (!validateQuote(request.body)) return reply.code(400).send({ error: 'INVALID_QUOTE_REQUEST' });
    if (!options.quotes) return reply.code(503).send({ error: 'NO_VERIFIED_LIQUIDITY_ADAPTERS', quotes: [] });
    try {
      const result = options.quotes.compare
        ? await options.quotes.compare(request.body)
        : { quotes: [await options.quotes.quote(request.body)], coverage: { venues: ['qwap'], routeScope: 'direct-and-via-wqms', complete: true } };
      const quotes = result.quotes.map((quote, index) => ({ ...quote, quoteId: store.put(request.body, quote), bestAvailablePrice: index === 0 }));
      if (!quotes.length) return reply.code(503).send({ error: 'NO_AVAILABLE_QUOTES', ...result });
      return { quotes, coverage: result.coverage, ranking: 'output-before-gas' };
    } catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code, quotes: [] });
      throw error;
    }
  });
  app.post<{ Body: AdditionRequest }>('/v1/liquidity/add/prepare', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['chainId', 'venue', 'tokenA', 'tokenB', 'amountADesired', 'amountBDesired', 'slippageBps', 'wallet'],
      properties: {
        chainId: { type: 'integer', const: CHAIN_ID }, venue: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        tokenA: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, tokenB: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        amountADesired: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' }, amountBDesired: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' }, slippageBps: { type: 'integer', minimum: 0, maximum: 500 },
      },
    } },
  }, async (request, reply) => {
    if (!addition) return reply.code(503).send({ error: 'LIQUIDITY_PREPARATION_DISABLED' });
    try { return await addition.prepare(request.body); }
    catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post<{ Body: RemovalRequest }>('/v1/liquidity/remove/prepare', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['chainId', 'venue', 'tokenA', 'tokenB', 'liquidity', 'slippageBps', 'wallet'],
      properties: {
        chainId: { type: 'integer', const: CHAIN_ID }, venue: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' },
        tokenA: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' }, tokenB: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        liquidity: { type: 'string', pattern: '^[1-9][0-9]{0,77}$' }, slippageBps: { type: 'integer', minimum: 0, maximum: 500 },
      },
    } },
  }, async (request, reply) => {
    if (!removal) return reply.code(503).send({ error: 'LIQUIDITY_PREPARATION_DISABLED' });
    try { return await removal.prepare(request.body); }
    catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.post<{ Body: { quoteId: string; wallet: string } }>('/v1/transactions/prepare', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['quoteId', 'wallet'],
      properties: {
        quoteId: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' },
        wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
      },
    } },
  }, async (request, reply) => {
    if (!preparer) return reply.code(503).send({ error: 'TRANSACTION_PREPARATION_DISABLED' });
    try { return await preparer.prepare(request.body.quoteId, request.body.wallet); }
    catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  app.get<{ Params: { hash: string } }>('/v1/transactions/:hash', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', additionalProperties: false, required: ['hash'], properties: {
      hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$' },
    } } },
  }, async (request, reply) => {
    if (!options.tracker) return reply.code(503).send({ error: 'TRANSACTION_TRACKING_DISABLED' });
    try { return await options.tracker.status(request.params.hash); }
    catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code });
      throw error;
    }
  });
  return app;
}
