import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
const root = new URL('../', import.meta.url);
const specifications = [
  ['@uniswap/v2-core', '1.0.1', 'UniswapV2Factory', '0x8716c49c3c982e1d8b8beaab0a95d88cc5ec06681dded0f951fa1f3059c1e32a'],
  ['@uniswap/v2-core', '1.0.1', 'UniswapV2Pair', '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f'],
  ['@uniswap/v2-periphery', '1.1.0-beta.0', 'UniswapV2Router02', '0x60ed3c9563fab19baceb6555668bf136db1f18d96b3b177f3726fccdb254f94b'],
];
const output = {};
for (const [pkg, version, name, hash] of specifications) {
  const metadata = JSON.parse(readFileSync(new URL(`node_modules/${pkg}/package.json`, root)));
  if (metadata.version !== version || metadata.license !== 'GPL-3.0-or-later') throw new Error(`Unexpected package metadata: ${pkg}`);
  const artifact = JSON.parse(readFileSync(new URL(`node_modules/${pkg}/build/${name}.json`, root)));
  const bytecode = artifact.bytecode.startsWith('0x') ? artifact.bytecode : `0x${artifact.bytecode}`;
  if (keccak256(bytecode) !== hash) throw new Error(`Unreviewed creation bytecode: ${name}`);
  output[name] = bytecode;
}
const target = new URL('contracts/artifacts/upstream.json', root);
mkdirSync(new URL('contracts/artifacts/', root), { recursive: true });
writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
console.log(`Verified three pinned AMM artifacts: ${fileURLToPath(target)}`);
