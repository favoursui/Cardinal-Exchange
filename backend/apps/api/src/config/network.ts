import { createPublicClient, http } from 'viem';
import { CHAIN_ID } from '../../../../packages/core/src/quote.js';

export function readNetworkConfig(env: Record<string, string | undefined> = process.env) {
  const chain = env.QMS_CHAIN_ID ?? String(CHAIN_ID);
  // Registry addresses and execution policy currently support this network only.
  if (chain !== String(CHAIN_ID)) throw new Error('UNSUPPORTED_CHAIN_ID');
  const rpcUrl = env.QMS_RPC_URL ?? 'https://rpc.testnet.qms.finance';
  try {
    const url = new URL(rpcUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!rpcUrl || /\s/.test(rpcUrl) || url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
  } catch { throw new Error('INVALID_QMS_RPC_URL'); }
  return { chainId: Number(chain), rpcUrl };
}

export function createConfiguredClient(env: Record<string, string | undefined> = process.env) {
  const { rpcUrl } = readNetworkConfig(env);
  return createPublicClient({ transport: http(rpcUrl, { timeout: 8000, retryCount: 0, fetchOptions: { redirect: 'error' } }), cacheTime: 0 });
}

export async function verifyConfiguredChain(client: { getChainId(): Promise<number> }, expected: number) {
  let actual: number;
  try { actual = await client.getChainId(); }
  catch { throw new Error('RPC_CONNECTION_FAILED'); }
  if (actual !== expected) throw new Error('RPC_CHAIN_MISMATCH');
}
