// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {FeeTakingHook} from "v4-core/test/FeeTakingHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {RouterStockfill} from "../src/RouterStockfill.sol";
import {QuoterStockfill} from "../src/QuoterStockfill.sol";
import {IUniswapV3Factory, ISignatureTransfer} from "../src/interfaces/IExternal.sol";
import {NATIVE, HopKind, Hop, Leg} from "../src/RouteTypes.sol";

/// Canonical WETH9 behaviour, enough for the router.
contract WETH9 is MockERC20 {
    constructor() MockERC20("Wrapped Ether", "WETH", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        _burn(msg.sender, wad);
        payable(msg.sender).transfer(wad);
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// A token that burns 1% of every transfer (fee-on-transfer).
contract TaxToken is MockERC20 {
    constructor() MockERC20("Tax", "TAX", 18) {}

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        balanceOf[msg.sender] -= amount;
        unchecked {
            balanceOf[to] += amount - fee;
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount - fee;
        }
        return true;
    }
}

interface IV3PoolFull {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IV3FactoryFull is IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

/// Adds v3 liquidity (pays the mint callback).
contract V3Minter {
    function mint(address pool, int24 lo, int24 hi, uint128 liquidity) external {
        IV3PoolFull(pool).mint(address(this), lo, hi, liquidity, abi.encode(msg.sender));
    }

    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        if (owed0 > 0) MockERC20(IV3PoolFull(msg.sender).token0()).transferFrom(payer, msg.sender, owed0);
        if (owed1 > 0) MockERC20(IV3PoolFull(msg.sender).token1()).transferFrom(payer, msg.sender, owed1);
    }
}

abstract contract Base is Test {
    uint160 constant PRICE_1_1 = 79228162514264337593543950336; // sqrt(1) * 2^96
    int24 constant V4_LO = -887220;
    int24 constant V4_HI = 887220;

    PoolManager manager;
    IV3FactoryFull v3;
    WETH9 weth;
    PoolModifyLiquidityTest lp4;
    V3Minter lp3;
    RouterStockfill router;
    address permit2;
    QuoterStockfill quoter;

    MockERC20 usdg;
    MockERC20 nvda;
    MockERC20 tsla;
    MockERC20 meme;

    address user = makeAddr("user");

    function setUp() public virtual {
        manager = new PoolManager(address(this));
        v3 = IV3FactoryFull(_deployV3Factory());
        weth = new WETH9();
        lp4 = new PoolModifyLiquidityTest(manager);
        lp3 = new V3Minter();
        permit2 = _deployFromHex("test/bin/Permit2.hex");
        router = new RouterStockfill(v3, manager, address(weth), ISignatureTransfer(permit2));
        quoter = new QuoterStockfill(v3, manager, address(weth));

        usdg = new MockERC20("USDG", "USDG", 6);
        nvda = new MockERC20("NVIDIA", "NVDA", 18);
        tsla = new MockERC20("Tesla", "TSLA", 18);
        meme = new MockERC20("Meme", "MEME", 18);

        vm.deal(address(this), 1e27);
        vm.deal(user, 1_000 ether);
        weth.deposit{value: 1e26}();
        MockERC20[4] memory ts = [usdg, nvda, tsla, meme];
        for (uint256 i; i < ts.length; ++i) {
            ts[i].mint(address(this), 1e40);
            ts[i].mint(user, 1e30);
            ts[i].approve(address(lp3), type(uint256).max);
            ts[i].approve(address(lp4), type(uint256).max);
            vm.prank(user);
            ts[i].approve(address(router), type(uint256).max);
        }
        weth.approve(address(lp3), type(uint256).max);
        weth.approve(address(lp4), type(uint256).max);
        vm.prank(user);
        weth.approve(address(router), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                 POOLS
    //////////////////////////////////////////////////////////////*/

    function _deployV3Factory() internal returns (address) {
        return _deployFromHex("test/bin/UniswapV3Factory.hex");
    }

    function _deployFromHex(string memory file) internal returns (address deployed) {
        bytes memory code = vm.parseBytes(vm.readFile(file));
        assembly {
            deployed := create(0, add(code, 32), mload(code))
        }
        require(deployed != address(0), file);
    }

    function _v3Pool(address a, address b, uint24 fee, uint160 sqrtPrice, uint128 liquidity)
        internal
        returns (address pool)
    {
        pool = v3.createPool(a, b, fee);
        IV3PoolFull(pool).initialize(sqrtPrice);
        int24 spacing = fee == 100 ? int24(1) : fee == 500 ? int24(10) : fee == 3000 ? int24(60) : int24(200);
        if (liquidity > 0) lp3.mint(pool, (-887272 / spacing) * spacing, (887272 / spacing) * spacing, liquidity);
    }

    function _key(address a, address b, uint24 fee, int24 spacing, address hooks)
        internal
        pure
        returns (PoolKey memory)
    {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(hooks));
    }

    function _v4Pool(
        address a,
        address b,
        uint24 fee,
        int24 spacing,
        address hooks,
        uint160 sqrtPrice,
        int256 liquidity
    ) internal returns (PoolKey memory key) {
        key = _key(a, b, fee, spacing, hooks);
        manager.initialize(key, sqrtPrice);
        if (liquidity > 0) {
            int24 lo = (V4_LO / spacing) * spacing;
            int24 hi = (V4_HI / spacing) * spacing;
            // Overpays for native ETH pools; the helper keeps the excess.
            uint256 value = Currency.unwrap(key.currency0) == NATIVE ? 10_000 ether : 0;
            lp4.modifyLiquidity{value: value}(key, ModifyLiquidityParams(lo, hi, liquidity, 0), "");
        }
    }

    function _feeHookAddress() internal returns (address hookAddr) {
        hookAddr = address(
            uint160(
                Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
                    | Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                    | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
            )
        );
        vm.etch(hookAddr, address(new FeeTakingHook(manager)).code);
    }

    /*//////////////////////////////////////////////////////////////
                             ROUTE BUILDERS
    //////////////////////////////////////////////////////////////*/

    function _hopV3(address out, uint24 fee) internal pure returns (Hop memory) {
        return Hop(HopKind.V3, out, fee, 0, address(0));
    }

    function _hopV4(address out, uint24 fee, int24 spacing, address hooks) internal pure returns (Hop memory) {
        return Hop(HopKind.V4, out, fee, spacing, hooks);
    }

    function _hopWrap(address weth_) internal pure returns (Hop memory) {
        return Hop(HopKind.WRAP, weth_, 0, 0, address(0));
    }

    function _hopUnwrap() internal pure returns (Hop memory) {
        return Hop(HopKind.UNWRAP, NATIVE, 0, 0, address(0));
    }

    function _path(Hop memory a) internal pure returns (Hop[] memory p) {
        p = new Hop[](1);
        p[0] = a;
    }

    function _path(Hop memory a, Hop memory b) internal pure returns (Hop[] memory p) {
        p = new Hop[](2);
        p[0] = a;
        p[1] = b;
    }

    function _path(Hop memory a, Hop memory b, Hop memory c) internal pure returns (Hop[] memory p) {
        p = new Hop[](3);
        p[0] = a;
        p[1] = b;
        p[2] = c;
    }

    function _legs(uint256 amount, Hop[] memory hops) internal pure returns (Leg[] memory legs) {
        legs = new Leg[](1);
        legs[0] = Leg(amount, hops);
    }

    function _quote(address tokenIn, Hop[] memory hops, uint256 amount) internal returns (uint256 out) {
        (out,) = quoter.quotePath(tokenIn, hops, amount);
    }

    function _swap(address tokenIn, address tokenOut, Leg[] memory legs, uint256 minOut)
        internal
        returns (uint256 out)
    {
        vm.prank(user);
        out = router.swap(tokenIn, tokenOut, legs, minOut, user, block.timestamp);
    }

    function _swapETH(address tokenOut, Leg[] memory legs, uint256 value, uint256 minOut)
        internal
        returns (uint256 out)
    {
        vm.prank(user);
        out = router.swap{value: value}(NATIVE, tokenOut, legs, minOut, user, block.timestamp);
    }

    function _quoteOut(address tokenIn, Hop[] memory hops, uint256 amountOut) internal returns (uint256 amountIn) {
        (amountIn,) = quoter.quotePathExactOut(tokenIn, hops, amountOut);
    }

    function _swapExactOut(address tokenIn, address tokenOut, Leg[] memory legs, uint256 maxIn)
        internal
        returns (uint256 spent)
    {
        vm.prank(user);
        spent = router.swapExactOut(tokenIn, tokenOut, legs, maxIn, user, block.timestamp);
    }

    function _swapExactOutETH(address tokenOut, Leg[] memory legs, uint256 maxIn) internal returns (uint256 spent) {
        vm.prank(user);
        spent = router.swapExactOut{value: maxIn}(NATIVE, tokenOut, legs, maxIn, user, block.timestamp);
    }

    /// The router must never keep anything between calls.
    function _assertRouterEmpty() internal view {
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(usdg.balanceOf(address(router)), 0, "router kept USDG");
        assertEq(nvda.balanceOf(address(router)), 0, "router kept NVDA");
        assertEq(tsla.balanceOf(address(router)), 0, "router kept TSLA");
        assertEq(meme.balanceOf(address(router)), 0, "router kept MEME");
        assertEq(weth.balanceOf(address(router)), 0, "router kept WETH");
    }

    receive() external payable {}
}

/// USDG, NVDA, TSLA, MEME and WETH across v3 and v4, including a native ETH v4 pool.
abstract contract Venues is Base {
    uint128 constant DEEP = 1e24;
    int256 constant DEEP4 = 1e24;

    function setUp() public virtual override {
        super.setUp();
        _v3Pool(address(usdg), address(nvda), 500, PRICE_1_1, DEEP);
        _v3Pool(address(usdg), address(nvda), 3000, PRICE_1_1, DEEP / 4);
        _v3Pool(address(nvda), address(tsla), 3000, PRICE_1_1, DEEP);
        _v3Pool(address(weth), address(meme), 10000, PRICE_1_1, DEEP);
        _v3Pool(address(usdg), address(weth), 500, PRICE_1_1, DEEP);
        _v4Pool(address(usdg), address(nvda), 3000, 60, address(0), PRICE_1_1, DEEP4 / 2);
        _v4Pool(NATIVE, address(meme), 3000, 60, address(0), PRICE_1_1, 1e21);
        _v4Pool(address(tsla), address(meme), 3000, 60, address(0), PRICE_1_1, DEEP4);
    }
}
