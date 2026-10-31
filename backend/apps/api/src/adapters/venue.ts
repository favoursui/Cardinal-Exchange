import type { Address, Hex } from 'viem';
import { QWAP } from './qwap-registry.js';
export interface VenueConfig {
  id: string;
  name: string;
  router: Address;
  factory: Address;
  routerHash: Hex;
  factoryHash: Hex;
  wrappedGetter: 'WQMS' | 'WETH';
  executor?: { address: Address; codeHash: Hex; treasury: Address; feeBps: number };
  tokens: readonly { address: Address; symbol: string; decimals: number; codeHash: Hex }[];
}
export const QWAP_VENUE: VenueConfig = {
  id: 'qwap', name: 'QWAP', ...QWAP, wrappedGetter: 'WQMS',
};
// Cardinal config is injected only by local-fork tests until a public deployment
// is independently verified. No environment/HTTP contract-address overrides.
