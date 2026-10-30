import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { keccak256, zeroAddress } from 'viem';
import './prepare-amm-artifacts.mjs';
import { buildDeploymentPlan } from './lib/deployment-plan.mjs';
import { verifyDeployment } from './lib/verify-deployment.mjs';
const artifacts=JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json',import.meta.url),'utf8'));
const wrapped={address:'0x3333333333333333333333333333333333333333',codeHash:keccak256('0x00')};
const plan=buildDeploymentPlan({chainId:19480,deployer:'0x1111111111111111111111111111111111111111',feeAuthority:'0x2222222222222222222222222222222222222222',nonce:'7'},artifacts,wrapped.address);
const hashes=[`0x${'1'.repeat(64)}`,`0x${'2'.repeat(64)}`];
const blockHash=`0x${'a'.repeat(64)}`;
const time=1800000000000;
function client(overrides={}) {
  return {getChainId:async()=>19480,getBlock:async({blockNumber=12n}={})=>({number:blockNumber,hash:blockHash,timestamp:BigInt(time/1000)}),
    getTransaction:async({hash})=>{const i=hashes.indexOf(hash),step=plan.transactions[i];return{hash,from:plan.deployer,to:null,nonce:7+i,value:0n,input:step.transaction.data,blockNumber:10n,blockHash};},
    getTransactionReceipt:async({hash})=>{const i=hashes.indexOf(hash);return{transactionHash:hash,from:plan.deployer,to:null,status:'success',contractAddress:plan.transactions[i].predictedAddress,blockNumber:10n,blockHash,transactionIndex:i};},
    getCode:async()=> '0x00',call:async()=>({data:'0x00'}),
    readContract:async({functionName,blockNumber})=>{assert.equal(blockNumber,12n);return{feeToSetter:plan.feeAuthority,feeTo:zeroAddress,allPairsLength:0n,factory:plan.predictedAddresses.factory,WETH:wrapped.address}[functionName];},...overrides};
}
const verify=(rpc=client(),candidate=plan)=>verifyDeployment(rpc,candidate,artifacts,wrapped,hashes,()=>time);
test('verifies pinned deployment, runtime and configuration without claiming finality or audit',async()=>{
  const result=await verify();assert.equal(result.deployments.length,2);assert.equal(result.status,'deployment-checks-passed');assert.equal(result.limitations.registryUpdated,false);assert.equal(result.limitations.multisigReviewComplete,false);
});
test('rejects modified plan before RPC',async()=>{
  const changed=structuredClone(plan);changed.transactions[1].transaction.data='0x00';
  await assert.rejects(verify(client({getChainId:async()=>assert.fail('No RPC')}),changed),/Plan differs/);
});
test('rejects wrong chain, insufficient confirmations, missing code and runtime mismatch',async()=>{
  await assert.rejects(verify(client({getChainId:async()=>1})),/chain mismatch/);
  await assert.rejects(verify(client({getBlock:async()=>({number:11n,hash:blockHash,timestamp:BigInt(time/1000)})})),/confirmations/);
  await assert.rejects(verify(client({getCode:async()=>undefined})),/runtime differs/);
  await assert.rejects(verify(client({call:async()=>({data:'0x01'})})),/runtime differs/);
});
test('rejects wrong constructor, reverted creation, admin changes, nonempty factory and reorg',async()=>{
  const base=client();
  await assert.rejects(verify(client({getTransaction:async(args)=>({...await base.getTransaction(args),input:'0x00'})})),/does not match/);
  await assert.rejects(verify(client({getTransactionReceipt:async(args)=>({...await base.getTransactionReceipt(args),status:'reverted'})})),/creation receipt/);
  for(const functionName of ['feeToSetter','feeTo','allPairsLength','factory','WETH'])await assert.rejects(verify(client({readContract:async(args)=>args.functionName===functionName?(functionName==='allPairsLength'?1n:plan.deployer):base.readContract(args)})));
  let reads=0;
  await assert.rejects(verify(client({getBlock:async(args)=>({...await base.getBlock(args),hash:++reads>=4?`0x${'b'.repeat(64)}`:blockHash})})),/reorged/);
});
