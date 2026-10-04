// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {VaultStockfill} from "../VaultStockfill.sol";

/// @title BasketStockfill
/// @notice One USDG deposit spread across several Vaults. The keeper moves capital between listed
///         Vaults as their Yield Rates change, within a per-Vault allocation ceiling.
/// @dev Launches closed (`heldValueCap` 0). USDG exits are served from idle balance only;
///      `redeemInKind` always returns the holder's slice of every Vault position instead.
contract BasketStockfill is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    uint256 public constant MAX_VAULTS = 8;
    uint256 private constant BPS = 10_000;

    VaultStockfill[] private _vaults;
    mapping(address => bool) public isListed;

    uint256 public heldValueCap;
    uint16 public maxAllocationBps = 4_000;

    event VaultListed(address indexed vault);
    event VaultDelisted(address indexed vault);
    event Allocated(address indexed vault, uint256 assets, uint256 shares);
    event Deallocated(address indexed vault, uint256 shares, uint256 assets);
    event RedeemedInKind(address indexed owner, address indexed receiver, uint256 shares, uint256 usdg);
    event HeldValueCapSet(uint256 cap);
    event MaxAllocationSet(uint16 bps);

    error InvalidConfig();
    error NotListed();
    error OverAllocated();
    error StillHeld();

    constructor(IERC20 usdg, address admin, address guardian, address keeper, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(usdg)
    {
        if (admin == address(0) || guardian == address(0) || keeper == address(0) || admin == guardian) {
            revert InvalidConfig();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    function vaults() external view returns (VaultStockfill[] memory) {
        return _vaults;
    }

    function allPricesFresh() public view returns (bool) {
        for (uint256 i; i < _vaults.length; ++i) {
            if (_vaults[i].balanceOf(address(this)) != 0 && !_vaults[i].priceFresh()) return false;
        }
        return true;
    }

    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        for (uint256 i; i < _vaults.length; ++i) {
            uint256 shares = _vaults[i].balanceOf(address(this));
            if (shares != 0) total += _vaults[i].convertToAssets(shares);
        }
    }

    function maxDeposit(address) public view override returns (uint256) {
        if (paused() || !allPricesFresh()) return 0;
        uint256 held = totalAssets();
        return heldValueCap > held ? heldValueCap - held : 0;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : _convertToShares(assets, Math.Rounding.Floor);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (!allPricesFresh()) return 0;
        return Math.min(super.maxWithdraw(owner), IERC20(asset()).balanceOf(address(this)));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (!allPricesFresh()) return 0;
        return Math.min(
            super.maxRedeem(owner),
            _convertToShares(IERC20(asset()).balanceOf(address(this)), Math.Rounding.Floor)
        );
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        return super.redeem(shares, receiver, owner);
    }

    /// @notice Burns Program shares for pro-rata idle USDG plus Vault shares, with no price check.
    function redeemInKind(uint256 shares, address receiver, address owner)
        external
        nonReentrant
        returns (uint256 usdgOut)
    {
        if (shares == 0) revert InvalidConfig();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        uint256 supply = totalSupply();
        _burn(owner, shares);
        usdgOut = Math.mulDiv(IERC20(asset()).balanceOf(address(this)), shares, supply);
        if (usdgOut != 0) IERC20(asset()).safeTransfer(receiver, usdgOut);
        for (uint256 i; i < _vaults.length; ++i) {
            uint256 part = Math.mulDiv(_vaults[i].balanceOf(address(this)), shares, supply);
            if (part != 0) IERC20(address(_vaults[i])).safeTransfer(receiver, part);
        }
        emit RedeemedInKind(owner, receiver, shares, usdgOut);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /*//////////////////////////////////////////////////////////////
                                 KEEPER
    //////////////////////////////////////////////////////////////*/

    function allocate(VaultStockfill vault, uint256 assets) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        if (!isListed[address(vault)]) revert NotListed();
        IERC20(asset()).forceApprove(address(vault), assets);
        uint256 shares = vault.deposit(assets, address(this));
        uint256 inVault = vault.convertToAssets(vault.balanceOf(address(this)));
        if (inVault * BPS > totalAssets() * maxAllocationBps) revert OverAllocated();
        emit Allocated(address(vault), assets, shares);
    }

    function deallocate(VaultStockfill vault, uint256 shares) external onlyRole(KEEPER_ROLE) nonReentrant {
        if (!isListed[address(vault)]) revert NotListed();
        uint256 assets = vault.redeem(shares, address(this), address(this));
        emit Deallocated(address(vault), shares, assets);
    }

    /*//////////////////////////////////////////////////////////////
                               GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function listVault(VaultStockfill vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isListed[address(vault)] || _vaults.length >= MAX_VAULTS || vault.asset() != asset()) revert InvalidConfig();
        isListed[address(vault)] = true;
        _vaults.push(vault);
        emit VaultListed(address(vault));
    }

    function delistVault(VaultStockfill vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!isListed[address(vault)]) revert NotListed();
        if (vault.balanceOf(address(this)) != 0) revert StillHeld();
        isListed[address(vault)] = false;
        for (uint256 i; i < _vaults.length; ++i) {
            if (_vaults[i] == vault) {
                _vaults[i] = _vaults[_vaults.length - 1];
                _vaults.pop();
                break;
            }
        }
        emit VaultDelisted(address(vault));
    }

    function setHeldValueCap(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function lowerHeldValueCap(uint256 cap) external onlyRole(GUARDIAN_ROLE) {
        if (cap > heldValueCap) revert InvalidConfig();
        heldValueCap = cap;
        emit HeldValueCapSet(cap);
    }

    function setMaxAllocationBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps == 0 || bps > BPS) revert InvalidConfig();
        maxAllocationBps = bps;
        emit MaxAllocationSet(bps);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
