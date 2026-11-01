import { createAdditionReader } from './services/prepare-addition.js';
import { createConfiguredClient, readNetworkConfig, verifyConfiguredChain } from './config/network.js';
import { createRemovalReader } from './services/prepare-removal.js';
import { buildApp } from './app.js';
import { createQwapReader, QwapQuotes } from './adapters/qwap.js';
import { createExecutionReader } from './services/prepare-swap.js';
import { VenueQuotes } from './services/venue-quotes.js';
import { createStatusReader, TransactionTracker } from './services/transaction-status.js';
async function start() {
  const port = process.env.PORT ?? '3001';
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid PORT');
  if (process.env.QWAP_QUOTES_ENABLED !== undefined && !['true', 'false'].includes(process.env.QWAP_QUOTES_ENABLED)) {
    throw new Error('QWAP_QUOTES_ENABLED must be true or false');
  }
  if (process.env.SWAP_PREPARATION_ENABLED !== undefined && !['true', 'false'].includes(process.env.SWAP_PREPARATION_ENABLED)) {
    throw new Error('SWAP_PREPARATION_ENABLED must be true or false');
  }
  if (process.env.SWAP_PREPARATION_ENABLED === 'true' && process.env.QWAP_QUOTES_ENABLED !== 'true') {
    throw new Error('Swap preparation requires QWAP_QUOTES_ENABLED=true');
  }
  if (process.env.LIQUIDITY_PREPARATION_ENABLED !== undefined && !['true', 'false'].includes(process.env.LIQUIDITY_PREPARATION_ENABLED)) {
    throw new Error('LIQUIDITY_PREPARATION_ENABLED must be true or false');
  }
  if (process.env.LIQUIDITY_PREPARATION_ENABLED === 'true' && process.env.QWAP_QUOTES_ENABLED !== 'true') {
    throw new Error('Liquidity preparation requires QWAP_QUOTES_ENABLED=true');
  }
  const network = readNetworkConfig();
  const rpcClient = createConfiguredClient();
  await verifyConfiguredChain(rpcClient, network.chainId);
  const quoteReader = createQwapReader(rpcClient);
  const qwap = new QwapQuotes(quoteReader);
  const app = await buildApp({ logger: true,
    ...(process.env.LIQUIDITY_PREPARATION_ENABLED === 'true' ? { removalExecution: createRemovalReader(rpcClient), additionExecution: createAdditionReader(rpcClient) } : {}),
    tracker: new TransactionTracker(createStatusReader(rpcClient)),
    ...(process.env.QWAP_QUOTES_ENABLED === 'true' ? { quotes: new VenueQuotes(quoteReader, [qwap]), pools: [qwap], wallets: [qwap] } : {}),
    ...(process.env.SWAP_PREPARATION_ENABLED === 'true' ? { execution: createExecutionReader(rpcClient) } : {}),
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ port: Number(port), host: '127.0.0.1' });

}
void start().catch(() => {
  // Provider exceptions may embed credentials; never print their URLs or causes.
  console.error('API startup failed. Check PORT, feature flags, QMS_RPC_URL and QMS_CHAIN_ID (supported: 19480).');
  process.exitCode = 1;
});
