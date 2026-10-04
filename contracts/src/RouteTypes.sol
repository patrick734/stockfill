// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Native ETH, as in Uniswap v4.
address constant NATIVE = address(0);

enum HopKind {
    V3,
    V4,
    WRAP,
    UNWRAP
}

/// @param kind        V3 and V4 swap through a pool; WRAP and UNWRAP convert ETH and WETH 1:1.
/// @param tokenOut    Token this hop delivers. Its input is the previous hop's output.
/// @param fee         v3 fee tier or v4 LP fee.
/// @param tickSpacing v4 only.
/// @param hooks       v4 only.
struct Hop {
    HopKind kind;
    address tokenOut;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// @notice One path of a split route. `amount` is the leg's input on exact-input swaps and its
///         output on exact-output swaps.
struct Leg {
    uint256 amount;
    Hop[] hops;
}

/// @param amountLimit Minimum output when `exactOut` is false, maximum input when it is true.
struct Trade {
    address tokenIn;
    address tokenOut;
    bool exactOut;
    uint256 amountLimit;
    address recipient;
    uint256 deadline;
}

/// @notice EIP-2612 signature from the swapper, with the router as spender.
struct Permit {
    uint256 value;
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
}

/// @notice Permit2 signature transfer from the swapper, with the router as spender.
struct Permit2Transfer {
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
    bytes signature;
}
