// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title RegistryStockfill
/// @notice Canonical on-chain list of Stockfill Vaults, Credit Lines and Programs for the app and indexers.
contract RegistryStockfill is Ownable2Step {
    enum Kind {
        VaultStockfill,
        CreditLine,
        Program
    }

    struct Entry {
        address target;
        Kind kind;
        string ticker;
        bool listed;
    }

    Entry[] private _entries;
    mapping(address target => uint256) public indexPlusOne;

    event Listed(address indexed target, Kind kind, string ticker);
    event Delisted(address indexed target);

    error AlreadyListed();
    error Unknown();

    constructor(address owner_) Ownable(owner_) {}

    function list(address target, Kind kind, string calldata ticker) external onlyOwner {
        if (indexPlusOne[target] != 0) revert AlreadyListed();
        _entries.push(Entry(target, kind, ticker, true));
        indexPlusOne[target] = _entries.length;
        emit Listed(target, kind, ticker);
    }

    function delist(address target) external onlyOwner {
        uint256 i = indexPlusOne[target];
        if (i == 0) revert Unknown();
        _entries[i - 1].listed = false;
        emit Delisted(target);
    }

    function entries() external view returns (Entry[] memory) {
        return _entries;
    }
}
