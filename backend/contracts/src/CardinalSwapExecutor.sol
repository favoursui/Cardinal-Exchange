// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface ExecutorToken {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}
interface ExecutorRouter {
    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address, uint256)
        external returns (uint256[] memory);
}

/// @notice Experimental standard-ERC20 V2 executor. Not audited or deployed publicly.
/// @dev Immutable fee, treasury and code-pinned allowlists. No admin, upgrades or arbitrary calls.
contract CardinalSwapExecutor {
    uint16 public constant MAX_FEE_BPS = 50;
    uint16 public immutable feeBps;
    address public immutable treasury;
    mapping(address => bytes32) public routerCodeHashes;
    mapping(address => bytes32) public tokenCodeHashes;
    bool private entered;
    struct SwapState {
        address input;
        address output;
        uint256 beforeInput;
        uint256 beforeOutput;
        uint256 fee;
        uint256 net;
    }
    event SwapExecuted(address indexed wallet, address indexed router, address indexed tokenIn,
        address tokenOut, uint256 grossInput, uint256 feeAmount, uint256 output);

    constructor(address recipient, uint16 bps, address[] memory routers, address[] memory tokens) {
        require(recipient != address(0) && recipient != address(this), "TREASURY");
        require(bps > 0 && bps <= MAX_FEE_BPS, "FEE");
        require(routers.length > 0 && routers.length <= 4 && tokens.length >= 2 && tokens.length <= 32, "REGISTRY_SIZE");
        treasury = recipient;
        feeBps = bps;
        for (uint256 i; i < routers.length; ++i) {
            address router = routers[i];
            require(router.code.length > 0 && routerCodeHashes[router] == 0, "ROUTER");
            routerCodeHashes[router] = router.codehash;
        }
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            require(token.code.length > 0 && tokenCodeHashes[token] == 0, "TOKEN");
            tokenCodeHashes[token] = token.codehash;
        }
    }

    function feeFor(uint256 amount) public view returns (uint256) {
        // floor(amount * bps / 10000), without overflowing on uint256 input.
        return amount / 10000 * feeBps + (amount % 10000) * feeBps / 10000;
    }

    function swap(address router, uint256 amountIn, uint256 minimumOut, address[] calldata path, uint256 deadline)
        external returns (uint256[] memory amounts)
    {
        require(!entered, "REENTRANCY");
        entered = true;
        require(deadline >= block.timestamp && amountIn > 0 && minimumOut > 0, "LIMITS");
        require(routerCodeHashes[router] != 0 && router.codehash == routerCodeHashes[router], "ROUTER");
        require(path.length >= 2 && path.length <= 3, "PATH");
        for (uint256 i; i < path.length; ++i) {
            require(tokenCodeHashes[path[i]] != 0 && path[i].codehash == tokenCodeHashes[path[i]], "TOKEN");
            for (uint256 j; j < i; ++j) require(path[i] != path[j], "PATH");
        }
        SwapState memory state;
        state.input = path[0];
        state.output = path[path.length - 1];
        state.beforeInput = ExecutorToken(state.input).balanceOf(address(this));
        state.beforeOutput = ExecutorToken(state.output).balanceOf(msg.sender);
        state.fee = feeFor(amountIn);
        state.net = amountIn - state.fee;
        safeCall(state.input, abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amountIn));
        require(ExecutorToken(state.input).balanceOf(address(this)) == state.beforeInput + amountIn, "INPUT_TRANSFER");
        // Exact per-swap router allowance; clear on both sides of execution.
        safeCall(state.input, abi.encodeWithSignature("approve(address,uint256)", router, 0));
        safeCall(state.input, abi.encodeWithSignature("approve(address,uint256)", router, state.net));
        amounts = ExecutorRouter(router).swapExactTokensForTokens(state.net, minimumOut, path, msg.sender, deadline);
        safeCall(state.input, abi.encodeWithSignature("approve(address,uint256)", router, 0));
        require(ExecutorToken(state.input).allowance(address(this), router) == 0, "RESIDUAL_ALLOWANCE");
        uint256 received = ExecutorToken(state.output).balanceOf(msg.sender) - state.beforeOutput;
        require(amounts.length == path.length && amounts[0] == state.net && received >= minimumOut && amounts[path.length - 1] == received, "OUTPUT_TRANSFER");
        if (state.fee > 0) {
            uint256 beforeTreasury = ExecutorToken(state.input).balanceOf(treasury);
            safeCall(state.input, abi.encodeWithSignature("transfer(address,uint256)", treasury, state.fee));
            require(ExecutorToken(state.input).balanceOf(treasury) == beforeTreasury + state.fee, "FEE_TRANSFER");
        }
        require(ExecutorToken(state.input).balanceOf(address(this)) == state.beforeInput, "RESIDUAL_INPUT");
        emit SwapExecuted(msg.sender, router, state.input, state.output, amountIn, state.fee, received);
        entered = false;
    }

    function safeCall(address token, bytes memory data) private {
        (bool ok, bytes memory result) = token.call(data);
        require(ok && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool)))), "TOKEN_CALL");
    }
}
