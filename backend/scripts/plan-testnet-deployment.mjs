// Read-only preflight and unsigned creation transactions. No signing capability.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256 } from 'viem';
import { buildDeploymentPlan, validateDeploymentConfig } from './lib/deployment-plan.mjs';
import { QWAP } from '../dist/apps/api/src/adapters/qwap-registry.js';

const args=process.argv.slice(2);
if(args.length!==4 || args[0]!=='--config' || args[2]!=='--out') throw new Error('Usage: npm run deployment:plan -- --config <public-config.json> --out <new-plan.json>');
const config=validateDeploymentConfig(JSON.parse(readFileSync(args[1],'utf8')));
await import('./prepare-amm-artifacts.mjs');
const artifacts=JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json',import.meta.url),'utf8'));
const plan=buildDeploymentPlan(config,artifacts,QWAP.tokens[0].address);
const client=createPublicClient({transport:http(QWAP.rpcUrl,{timeout:8000,retryCount:0}),cacheTime:0});
const chainId=await client.getChainId();
if(chainId!==19480) throw new Error('RPC chain mismatch');
const block=await client.getBlock();
if(block.number===null || block.hash===null || Math.abs(Math.floor(Date.now()/1000)-Number(block.timestamp))>120) throw new Error('Missing or stale snapshot');
const blockNumber=block.number;
const [nonce,pendingNonce,wrappedCode,authorityCode,deployerCode,factoryCode,routerCode,balance]=await Promise.all([
  client.getTransactionCount({address:config.deployer,blockNumber}),client.getTransactionCount({address:config.deployer,blockTag:'pending'}),
  client.getCode({address:plan.wrappedNative,blockNumber}),client.getCode({address:config.feeAuthority,blockNumber}),
  client.getCode({address:config.deployer,blockNumber}),client.getCode({address:plan.predictedAddresses.factory,blockNumber}),
  client.getCode({address:plan.predictedAddresses.router,blockNumber}),client.getBalance({address:config.deployer,blockNumber}),
]);
if(BigInt(nonce)!==BigInt(config.nonce) || pendingNonce!==nonce) throw new Error('Nonce mismatch or pending deployer transactions; regenerate plan');
if(!wrappedCode || keccak256(wrappedCode)!==QWAP.tokens[0].codeHash) throw new Error('Wrapped-native runtime identity mismatch');
if(!authorityCode || authorityCode==='0x') throw new Error('Fee authority must be a deployed, separately reviewed multisig contract');
if(deployerCode && deployerCode!=='0x') throw new Error('Only ordinary EOA deployers supported by this CREATE planner');
if([factoryCode,routerCode].some(code=>code && code!=='0x')) throw new Error('Predicted deployment address already has code');
if(balance===0n) throw new Error('Deployer has no testnet gas balance');
if((await client.getBlock({blockNumber})).hash!==block.hash) throw new Error('Snapshot reorg; regenerate plan');
plan.preflight={blockNumber:blockNumber.toString(),blockHash:block.hash,checkedAt:new Date().toISOString(),
  deployerBalance:balance.toString(),feeAuthorityCodeHash:keccak256(authorityCode),wrappedNativeCodeHash:keccak256(wrappedCode),
  fundingSufficiencyVerified:false,multisigOwnersAndThresholdVerified:false};
// Refuse to overwrite a previously reviewed plan.
writeFileSync(args[3],JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
console.log(`Unsigned testnet plan written to ${args[3]}. No transactions signed or broadcast.`);
