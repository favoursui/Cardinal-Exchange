import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { CHAIN_ID, validateQuote } from '../../../packages/core/src/quote.js';
import type { QuoteRequest } from '../../../packages/core/src/quote.js';
import { QuoteError } from './adapters/qwap.js';
import type { QwapQuotes } from './adapters/qwap.js';
import { QWAP } from './adapters/qwap-registry.js';
export async function buildApp(options: { logger?: boolean; rateLimitMax?: number; quotes?: QwapQuotes } = {}) {
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
      return { quotes: [await options.quotes.quote(request.body)], coverage: { venues: ['qwap'], routeScope: 'direct-and-via-wqms' } };
    } catch (error) {
      if (error instanceof QuoteError) return reply.code(error.status).send({ error: error.code, quotes: [] });
      throw error;
    }
  });
  return app;
}
