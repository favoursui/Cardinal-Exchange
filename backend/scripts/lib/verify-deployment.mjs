import { isDeepStrictEqual } from 'node:util';
import { getAddress, keccak256, parseAbi, zeroAddress } from 'viem';
import { buildDeploymentPlan } from './deployment-plan.mjs';
const abi=parseAbi([
  'function feeToSetter() view returns (address)', 'function feeTo() view returns (address)',
  'function allPairsLength() view returns (uint256)', 'function factory() view returns (address)',
  'function WETH() view returns (address)',
]);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};
export async function verifyDeployment(client,plan,artifacts,wrapped,hashes,now=Date.now) {
  const expected=buildDeploymentPlan({chainId:plan.chainId,deployer:plan.deployer,feeAuthority:plan.feeAuthority,nonce:plan.transactions?.[0]?.transaction?.nonce},artifacts,wrapped.address);
  for(const key of Object.keys(expected))requireValue(isDeepStrictEqual(plan[key],expected[key]),`Plan differs from pinned reconstruction: ${key}`);
  requireValue(Array.isArray(hashes)&&hashes.length===2&&hashes.every(h=>/^0x[0-9a-fA-F]{64}$/.test(h))&&!same(hashes[0],hashes[1]),'Provide distinct factory and router transaction hashes');
  requireValue(await client.getChainId()===19480,'RPC chain mismatch');
  const snapshot=await client.getBlock();
  requireValue(snapshot.number!==null&&snapshot.hash!==null,'Missing snapshot');
  const age=BigInt(Math.floor(now()/1000))-snapshot.timestamp;
  requireValue(age>=-15n&&age<=120n,'Stale snapshot');
  const blockNumber=snapshot.number;
  const evidence=[];
  for(const [i,step] of expected.transactions.entries()) {
    const hash=hashes[i];
    const [tx,receipt]=await Promise.all([client.getTransaction({hash}),client.getTransactionReceipt({hash})]);
    requireValue(same(tx.hash,hash)&&same(receipt.transactionHash,hash)&&receipt.status==='success'&&tx.to===null&&receipt.to===null,'Invalid creation receipt');
    requireValue(same(tx.from,expected.deployer)&&same(receipt.from,expected.deployer)&&BigInt(tx.nonce)===BigInt(step.transaction.nonce)&&tx.value===0n&&same(tx.input,step.transaction.data),'Deployment transaction does not match plan');
    requireValue(same(receipt.contractAddress,step.predictedAddress)&&tx.blockNumber===receipt.blockNumber&&same(tx.blockHash,receipt.blockHash),'Deployment inclusion mismatch');
    requireValue(receipt.blockNumber<=blockNumber&&blockNumber-receipt.blockNumber+1n>=3n,'Deployment needs at least three confirmations');
    const canonical=await client.getBlock({blockNumber:receipt.blockNumber});
    requireValue(same(canonical.hash,receipt.blockHash),'Deployment receipt reorged');
    if(i===1)requireValue(receipt.blockNumber>BigInt(evidence[0].blockNumber)||(receipt.blockNumber===BigInt(evidence[0].blockNumber)&&receipt.transactionIndex>evidence[0].transactionIndex),'Router must follow factory');
    const [code,simulation]=await Promise.all([
      client.getCode({address:step.predictedAddress,blockNumber}),
      // Pinned constructors are deterministic: factory stores the authority;
      // Router02 embeds the two constructor addresses. Neither makes external calls.
      client.call({account:expected.deployer,data:step.transaction.data,blockNumber}),
    ]);
    requireValue(code&&code!=='0x'&&simulation.data&&same(code,simulation.data),'Deployed runtime differs from pinned constructor output');
    evidence.push({step:step.step,address:step.predictedAddress,transactionHash:hash,blockNumber:receipt.blockNumber.toString(),blockHash:receipt.blockHash,transactionIndex:receipt.transactionIndex,runtimeCodeHash:keccak256(code)});
  }
  const read=(address,functionName)=>client.readContract({address,abi,functionName,blockNumber});
  const {factory,router}=expected.predictedAddresses;
  const [authority,feeRecipient,pairCount,routerFactory,routerWrapped,wrappedCode,authorityCode]=await Promise.all([
    read(factory,'feeToSetter'),read(factory,'feeTo'),read(factory,'allPairsLength'),read(router,'factory'),read(router,'WETH'),
    client.getCode({address:wrapped.address,blockNumber}),client.getCode({address:expected.feeAuthority,blockNumber}),
  ]);
  requireValue(same(authority,expected.feeAuthority)&&same(feeRecipient,zeroAddress)&&pairCount===0n,'Factory admin, fees or initial pool state differ from plan');
  requireValue(same(routerFactory,factory)&&same(routerWrapped,wrapped.address),'Router linkage mismatch');
  requireValue(wrappedCode&&keccak256(wrappedCode)===wrapped.codeHash,'Wrapped-native identity mismatch');
  requireValue(authorityCode&&authorityCode!=='0x','Fee authority has no code');
  for(const deployment of evidence)requireValue(same((await client.getBlock({blockNumber:BigInt(deployment.blockNumber)})).hash,deployment.blockHash),'Deployment receipt reorged during verification');
  requireValue(same((await client.getBlock({blockNumber})).hash,snapshot.hash),'Snapshot reorged during verification');
  return {schemaVersion:1,chainId:19480,status:'deployment-checks-passed',snapshot:{blockNumber:blockNumber.toString(),blockHash:snapshot.hash},
    deployments:evidence,feeAuthority:expected.feeAuthority,feeAuthorityCodeHash:keccak256(authorityCode),wrappedNative:wrapped.address,
    checkedAt:new Date(now()).toISOString(),limitations:{finalized:false,sourceVerificationComplete:false,multisigReviewComplete:false,mainnetApproved:false,registryUpdated:false}};
}
