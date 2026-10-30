import { getAddress, zeroAddress } from 'viem';
export const CHAIN_ID = 19480;
export const MAX_UINT256 = (1n << 256n) - 1n;
export interface QuoteRequest {
  chainId: number;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippageBps: number;
}
// JSON amounts use decimal strings; calculations use bigint, never floats.
export function validateQuote(q: QuoteRequest): boolean {
  try {
    const a = getAddress(q.tokenIn), b = getAddress(q.tokenOut);
    return q.chainId === CHAIN_ID && a !== b && a !== zeroAddress && b !== zeroAddress
      && /^[1-9][0-9]{0,77}$/.test(q.amountIn) && BigInt(q.amountIn) <= MAX_UINT256
      && Number.isInteger(q.slippageBps) && q.slippageBps >= 0 && q.slippageBps <= 500;
  } catch { return false; }
}
