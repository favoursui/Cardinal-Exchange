import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeAbiParameters, encodeDeployData, getContractAddress, parseAbi, zeroAddress } from 'viem';
import './prepare-amm-artifacts.mjs';
import { buildDeploymentPlan, validateDeploymentConfig } from './lib/deployment-plan.mjs';
const artifacts=JSON.parse(readFileSync(new URL('../contracts/artifacts/upstream.json',import.meta.url),'utf8'));
const config={chainId:19480,deployer:'0x1111111111111111111111111111111111111111',feeAuthority:'0x2222222222222222222222222222222222222222',nonce:'7'};
const wrapped='0x3333333333333333333333333333333333333333';
test('plan uses pinned creation code, exact authority and sequential CREATE addresses',()=>{
  const plan=buildDeploymentPlan(config,artifacts,wrapped);
  assert.equal(plan.predictedAddresses.factory,getContractAddress({from:config.deployer,nonce:7n}));
  assert.equal(plan.predictedAddresses.router,getContractAddress({from:config.deployer,nonce:8n}));
  assert.deepEqual(plan.transactions.map(step=>step.transaction.nonce),['7','8']);
  assert.equal(plan.transactions[0].transaction.data,encodeDeployData({abi:parseAbi(['constructor(address)']),bytecode:artifacts.UniswapV2Factory,args:[config.feeAuthority]}));
  const routerArgs=`0x${plan.transactions[1].transaction.data.slice(artifacts.UniswapV2Router02.length)}`;
  assert.deepEqual(decodeAbiParameters([{type:'address'},{type:'address'}],routerArgs),[plan.predictedAddresses.factory,wrapped]);
  assert.equal(plan.initialFeeRecipient,zeroAddress);assert.equal(plan.constraints.broadcast,false);
  assert.ok(plan.transactions.every(step=>step.transaction.value==='0'&&!('to' in step.transaction)));
  assert.deepEqual(buildDeploymentPlan(config,artifacts,wrapped),plan);
});
test('rejects mainnet, missing authority, unexpected fields, malformed nonce and shared authority',()=>{
  for(const patch of [{chainId:1},{feeAuthority:zeroAddress},{feeAuthority:config.deployer},{deployer:'bad'},{nonce:7},{nonce:'-1'},{nonce:'01'},{nonce:((1n<<64n)-2n).toString()},{privateKey:'never accepted'},{rpcUrl:'http://untrusted'}])assert.throws(()=>validateDeploymentConfig({...config,...patch}));
});
test('rejects changed creation artifacts and invalid wrapped native',()=>{
  for(const name of Object.keys(artifacts))assert.throws(()=>buildDeploymentPlan(config,{...artifacts,[name]:'0x00'},wrapped),/Unreviewed artifact/);
  assert.throws(()=>buildDeploymentPlan(config,artifacts,zeroAddress),/Invalid wrapped/);
});
