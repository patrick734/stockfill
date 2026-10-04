// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {RouterStockfill} from "../src/RouterStockfill.sol";
import {QuoterStockfill} from "../src/QuoterStockfill.sol";
import {IUniswapV3Factory, ISignatureTransfer} from "../src/interfaces/IExternal.sol";

/// @notice Deploys RouterStockfill and QuoterStockfill. launch.sh signs it with an encrypted keystore:
///   forge script script/DeployStockfill.s.sol --rpc-url robinhood --broadcast --account <name> --password-file <file>
/// The router uses Permit2 only if it is deployed at its canonical address.
contract DeployStockfill is Script {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        require(V3_FACTORY.code.length > 0, "v3 factory missing");
        require(POOL_MANAGER.code.length > 0, "v4 PoolManager missing");
        require(WETH.code.length > 0, "WETH missing");
        address permit2 = PERMIT2.code.length > 0 ? PERMIT2 : address(0);

        vm.startBroadcast();
        RouterStockfill router = new RouterStockfill(
            IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH, ISignatureTransfer(permit2)
        );
        QuoterStockfill quoter = new QuoterStockfill(IUniswapV3Factory(V3_FACTORY), IPoolManager(POOL_MANAGER), WETH);
        vm.stopBroadcast();

        console2.log("ROUTER=", address(router));
        console2.log("QUOTER=", address(quoter));
        console2.log("PERMIT2=", permit2);
    }
}
