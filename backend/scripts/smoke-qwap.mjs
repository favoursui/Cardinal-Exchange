// Read-only opt-in integration check. Build first. No secrets or wallet required.
import { buildApp } from '../dist/apps/api/src/app.js';
import { QwapQuotes, createQwapReader } from '../dist/apps/api/src/adapters/qwap.js';
import { QWAP } from '../dist/apps/api/src/adapters/qwap-registry.js';
const reader = createQwapReader();
// Log only operation names for live diagnostics; never raw upstream errors or URLs.
for (const method of ['chainId', 'block', 'codeHash', 'read']) {
  const original = reader[method].bind(reader);
  reader[method] = async (...args) => {
    try { return await original(...args); }
    catch (error) { console.error('RPC operation failed:', method, method === 'read' ? args[1] : '', error.name); throw error; }
  };
}
const app = await buildApp({ quotes: new QwapQuotes(reader) });
try {
  const response = await app.inject({ method: 'POST', url: '/v1/quotes', payload: {
    chainId: 19480, tokenIn: QWAP.tokens[1].address, tokenOut: QWAP.tokens[0].address,
    amountIn: '1000000', slippageBps: 50,
  } });
  console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json() }, null, 2));
  if (response.statusCode !== 200) process.exitCode = 1;
} finally { await app.close(); }
