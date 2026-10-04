// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RouterStockfill} from "../src/RouterStockfill.sol";
import {QuoterStockfill} from "../src/QuoterStockfill.sol";
import {IUniswapV3Factory, ISignatureTransfer} from "../src/interfaces/IExternal.sol";
import {WETH9, V3Minter, IV3PoolFull, IV3FactoryFull} from "../test/Base.t.sol";

/// A small copy of the Robinhood Chain venue landscape on a local anvil node, at realistic prices
/// and depths, for the engine's integration test and UI checks. Never used on mainnet.
///   anvil --chain-id 4663 --gas-limit 1000000000 --code-size-limit 50000 &
///   forge script script/LocalWorld.s.sol --tc LocalWorld --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
contract LocalWorld is Script {
    PoolManager manager;
    IV3FactoryFull v3;
    V3Minter lp3;
    PoolModifyLiquidityTest lp4;
    WETH9 weth;
    MockERC20 usdg;

    function run() external {
        vm.startBroadcast();
        address me = msg.sender;

        manager = new PoolManager(me);
        address f = _deployFromHex("test/bin/UniswapV3Factory.hex");
        v3 = IV3FactoryFull(f);
        weth = new WETH9();
        lp4 = new PoolModifyLiquidityTest(manager);
        lp3 = new V3Minter();
        address permit2 = _deployFromHex("test/bin/Permit2.hex");
        RouterStockfill router =
            new RouterStockfill(IUniswapV3Factory(f), manager, address(weth), ISignatureTransfer(permit2));
        QuoterStockfill quoter = new QuoterStockfill(IUniswapV3Factory(f), manager, address(weth));

        usdg = new MockERC20("USDG", "USDG", 6);
        MockERC20 nvda = new MockERC20("NVIDIA", "NVDA", 18);
        MockERC20 tsla = new MockERC20("Tesla", "TSLA", 18);
        MockERC20 aapl = new MockERC20("Apple", "AAPL", 18);
        MockERC20 meme = new MockERC20("Cash Cat", "CASHCAT", 18);

        weth.deposit{value: 2_000 ether}();
        MockERC20[6] memory ts = [usdg, nvda, tsla, aapl, meme, MockERC20(address(weth))];
        for (uint256 i; i < 6; ++i) {
            if (i < 5) ts[i].mint(me, 1e40);
            ts[i].approve(address(lp3), type(uint256).max);
            ts[i].approve(address(lp4), type(uint256).max);
            ts[i].approve(address(router), type(uint256).max);
        }

        // Prices in USD (18-decimal fixed point); depth = USD on the USDG side of each pool.
        // NVDA $180 on three venues of different depth: a big order should split.
        _pool(3, 500, 10, address(usdg), 1e18, address(nvda), 180e18, 1_200_000e6, 0);
        _pool(3, 3000, 60, address(usdg), 1e18, address(nvda), 180e18, 500_000e6, 0);
        _pool(4, 3000, 60, address(usdg), 1e18, address(nvda), 180e18, 400_000e6, 0);
        // TSLA $250 and AAPL $230, one venue each; plus a TSLA pool that drifted 2x off (must be ignored).
        _pool(3, 500, 10, address(usdg), 1e18, address(tsla), 250e18, 900_000e6, 0);
        _pool(3, 3000, 60, address(usdg), 1e18, address(tsla), 500e18, 300_000e6, 0);
        _pool(4, 500, 10, address(usdg), 1e18, address(aapl), 230e18, 700_000e6, 0);
        // ETH $3,000
        _pool(3, 500, 10, address(usdg), 1e18, address(weth), 3000e18, 2_000_000e6, 0);
        // A meme at $0.006 on WETH (v3) and native ETH (v4): depth given in ETH on the ETH side.
        _pool(3, 10000, 200, address(weth), 3000e18, address(meme), 6e15, 0, 60 ether);
        _pool(4, 3000, 60, address(0), 3000e18, address(meme), 6e15, 0, 40 ether);

        vm.stopBroadcast();

        string memory o = "world";
        vm.serializeAddress(o, "poolManager", address(manager));
        vm.serializeAddress(o, "v3Factory", f);
        vm.serializeAddress(o, "weth", address(weth));
        vm.serializeAddress(o, "router", address(router));
        vm.serializeAddress(o, "permit2", permit2);
        vm.serializeAddress(o, "quoter", address(quoter));
        vm.serializeAddress(o, "usdg", address(usdg));
        vm.serializeAddress(o, "nvda", address(nvda));
        vm.serializeAddress(o, "tsla", address(tsla));
        vm.serializeAddress(o, "aapl", address(aapl));
        string memory json = vm.serializeAddress(o, "meme", address(meme));
        vm.writeJson(json, "local-world.json");
    }

    function _deployFromHex(string memory file) internal returns (address deployed) {
        bytes memory code = vm.parseBytes(vm.readFile(file));
        assembly {
            deployed := create(0, add(code, 32), mload(code))
        }
        require(deployed != address(0), file);
    }

    /// Creates and funds a full-range pool between `a` and `b` at the given USD prices.
    /// `depthA` is the amount of `a` (raw units) to put in; if zero, `depthAEth` is used instead
    /// (for ETH/WETH-side pools).
    function _pool(
        uint8 version,
        uint24 fee,
        int24 spacing,
        address a,
        uint256 usdA,
        address b,
        uint256 usdB,
        uint256 depthA,
        uint256 depthAEth
    ) internal {
        uint256 decA = a == address(0) ? 18 : MockERC20(a).decimals();
        uint256 decB = MockERC20(b).decimals();
        uint256 amountA = depthA > 0 ? depthA : depthAEth;
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        // raw1/raw0 = (price0 / price1) * 10^(dec1 - dec0)
        (uint256 p0, uint256 p1, uint256 d0, uint256 d1) = a == t0 ? (usdA, usdB, decA, decB) : (usdB, usdA, decB, decA);
        // sqrtPriceX96 = sqrt(raw1/raw0) * 2^96, computed as sqrt(num * 2^96 / den) * 2^48
        uint256 num = p0 * 10 ** d1;
        uint256 den = p1 * 10 ** d0;
        uint160 sqrtP = uint160(Math.sqrt(Math.mulDiv(num, 1 << 96, den)) << 48);
        // Full-range liquidity from the funded side: L = amount0 * sqrtP (a is token0) or amount1 / sqrtP.
        uint256 liq = a == t0 ? Math.mulDiv(amountA, sqrtP, 1 << 96) : Math.mulDiv(amountA, 1 << 96, sqrtP);

        int24 lo = (-887272 / spacing) * spacing;
        int24 hi = (887272 / spacing) * spacing;
        if (version == 3) {
            address pool = v3.createPool(t0, t1, fee);
            IV3PoolFull(pool).initialize(sqrtP);
            lp3.mint(pool, lo, hi, uint128(liq));
        } else {
            PoolKey memory key = PoolKey(Currency.wrap(t0), Currency.wrap(t1), fee, spacing, IHooks(address(0)));
            manager.initialize(key, sqrtP);
            uint256 value = t0 == address(0) ? amountA * 2 : 0;
            lp4.modifyLiquidity{value: value}(key, ModifyLiquidityParams(lo, hi, int256(liq), 0), "");
        }
    }
}
