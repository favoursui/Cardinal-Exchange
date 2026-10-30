// Local-only deployment verification integration. No public RPC or private keys.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import './prepare-amm-artifacts.mjs';
import { buildDeploymentPlan } from './lib/deployment-plan.mjs';
import { verifyDeployment } from './lib/verify-deployment.mjs';
const transport=http('http://127.0.0.1:18546',{timeout:8000,retryCount:0});
const client=createPublicClient({transport,cacheTime:0});
assert.match(await client.request({method:'web3_clientVersion'}),/^anvil\//);
assert.equal(await client.getChainId(),19480);
const [account]=await client.request({method:'eth_accounts'});
const wallet=createWalletClient({account,transport});
const snapshot=await client.request({method:'evm_snapshot'});
const receipt=async hash=>{const result=await client.waitForTransactionReceipt({hash});assert.equal(result.status,'success');return result;};
try {
  // Dummy STOP contract used only as a local authority/wrapped-address fixture.
  // It is not a multisig or wrapped token and is never a public deployment candidate.
  const fixture=await receipt(await wallet.sendTransaction({chain:null,data:'0x6001600c60003960016000f300'}));
  const wrapped={address:fixture.contractAddress,codeHash:keccak256('0x00')};
  const artifacts=JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json',import.meta.url),'utf8'));
  const plan=buildDeploymentPlan({chainId:19480,deployer:account,feeAuthority:wrapped.address,nonce:String(await client.getTransactionCount({address:account}))},artifacts,wrapped.address);
  const hashes=[];
  for(const step of plan.transactions){const hash=await wallet.sendTransaction({chain:null,data:step.transaction.data,nonce:Number(step.transaction.nonce),value:0n});await receipt(hash);hashes.push(hash);}
  await client.request({method:'anvil_mine',params:['0x2']});
  const result=await verifyDeployment(client,plan,artifacts,wrapped,hashes);
  assert.equal(result.status,'deployment-checks-passed');
  console.log(JSON.stringify({status:'passed',scope:'localhost synthetic fixtures',checks:['exact creation transactions','predicted addresses','constructor runtime comparison','initial admin and router state','canonical receipts'],deployments:result.deployments},null,2));
} finally {assert.equal(await client.request({method:'evm_revert',params:[snapshot]}),true);}
