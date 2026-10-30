// Read-only verifier; never publishes or enables a registry entry.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { QWAP } from '../dist/apps/api/src/adapters/qwap-registry.js';
import { verifyDeployment } from './lib/verify-deployment.mjs';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--plan'||args[2]!=='--factory-tx'||args[4]!=='--router-tx'||args[6]!=='--out')throw new Error('Usage: npm run deployment:verify -- --plan <plan.json> --factory-tx <hash> --router-tx <hash> --out <new-evidence.json>');
const plan=JSON.parse(readFileSync(args[1],'utf8'));
await import('./prepare-amm-artifacts.mjs');
const artifacts=JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json',import.meta.url),'utf8'));
const client=createPublicClient({transport:http(QWAP.rpcUrl,{timeout:8000,retryCount:0}),cacheTime:0});
const result=await verifyDeployment(client,plan,artifacts,QWAP.tokens[0],[args[3],args[5]]);
writeFileSync(args[7],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(`Read-only verification evidence written to ${args[7]}. Registry remains unchanged.`);
