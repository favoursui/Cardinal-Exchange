import { buildApp } from './app.js';
import { createQwapReader, QwapQuotes } from './adapters/qwap.js';
const port = process.env.PORT ?? '3001';
if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PORT');
if (process.env.QWAP_QUOTES_ENABLED !== undefined && !['true', 'false'].includes(process.env.QWAP_QUOTES_ENABLED)) {
  throw new Error('QWAP_QUOTES_ENABLED must be true or false');
}
const app = await buildApp({ logger: true, ...(process.env.QWAP_QUOTES_ENABLED === 'true' ? { quotes: new QwapQuotes(createQwapReader()) } : {}) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
await app.listen({ port: Number(port), host: '127.0.0.1' });
