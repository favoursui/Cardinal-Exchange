import { encodeDeployData, getAddress, getContractAddress, isAddress, keccak256, parseAbi, zeroAddress } from 'viem';

const hashes = {
  UniswapV2Factory: '0x8716c49c3c982e1d8b8beaab0a95d88cc5ec06681dded0f951fa1f3059c1e32a',
  UniswapV2Pair: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
  UniswapV2Router02: '0x60ed3c9563fab19baceb6555668bf136db1f18d96b3b177f3726fccdb254f94b',
};
const factoryAbi = parseAbi(['constructor(address feeToSetter)']);
const routerAbi = parseAbi(['constructor(address factory,address wrappedNative)']);
export function validateDeploymentConfig(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'chainId,deployer,feeAuthority,nonce' || config.chainId !== 19480) throw new Error('Expected testnet chain 19480 and only deployer, feeAuthority, nonce fields');
  for (const field of ['deployer','feeAuthority']) {
    if (typeof config[field] !== 'string' || !isAddress(config[field]) || getAddress(config[field]) === zeroAddress) throw new Error(`Invalid ${field} public address`);
  }
  if (getAddress(config.deployer) === getAddress(config.feeAuthority)) throw new Error('Use a separate reviewed fee authority');
  if (typeof config.nonce !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(config.nonce) || BigInt(config.nonce) > BigInt(Number.MAX_SAFE_INTEGER)-1n) throw new Error('Nonce must leave room for two contract creations');
  return {...config,deployer:getAddress(config.deployer),feeAuthority:getAddress(config.feeAuthority)};
}
export function buildDeploymentPlan(input, artifacts, wrappedNative) {
  const config = validateDeploymentConfig(input);
  if (!isAddress(wrappedNative) || getAddress(wrappedNative) === zeroAddress) throw new Error('Invalid wrapped-native address');
  for (const [name, hash] of Object.entries(hashes)) if (!artifacts[name] || keccak256(artifacts[name]) !== hash) throw new Error(`Unreviewed artifact: ${name}`);
  const nonce=BigInt(config.nonce);
  const factory=getContractAddress({from:config.deployer,nonce});
  const router=getContractAddress({from:config.deployer,nonce:nonce+1n});
  const transaction=(n,data)=>({chainId:19480,from:config.deployer,nonce:n.toString(),value:'0',data});
  return {
    schemaVersion:1,network:'qms-testnet',chainId:19480,status:'unsigned-plan',deployer:config.deployer,
    feeAuthority:config.feeAuthority,initialFeeRecipient:zeroAddress,wrappedNative:getAddress(wrappedNative),
    predictedAddresses:{factory,router},creationCodeHashes:{...hashes},
    transactions:[
      {step:'factory',predictedAddress:factory,constructorArguments:[config.feeAuthority],transaction:transaction(nonce,encodeDeployData({abi:factoryAbi,bytecode:artifacts.UniswapV2Factory,args:[config.feeAuthority]}))},
      {step:'router',predictedAddress:router,constructorArguments:[factory,getAddress(wrappedNative)],transaction:transaction(nonce+1n,encodeDeployData({abi:routerAbi,bytecode:artifacts.UniswapV2Router02,args:[factory,getAddress(wrappedNative)]}))},
    ],
    constraints:{mainnetSupported:false,broadcast:false,seedLiquidity:false,requiresSequentialNonces:true,sourceVerificationComplete:false,feeAuthorityReviewComplete:false},
  };
}
