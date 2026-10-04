// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVaultOracle} from "./interfaces/IVaultOracle.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title OracleStockfill
/// @notice Chainlink pricing for Equity Tokens in USDG units. Each Equity Token feed quotes USD and is
///         converted through the USDG / USD feed, so a USDG depeg is priced rather than ignored.
/// @dev The owner is expected to be the timelock.
contract OracleStockfill is IVaultOracle, Ownable2Step {
    uint256 public constant SEQUENCER_GRACE = 1 hours;

    uint8 public immutable usdgDecimals;
    AggregatorV3Interface public immutable usdgFeed;
    uint32 public immutable usdgMaxAge;
    uint256 private immutable usdgFeedUnit;

    /// @notice L2 sequencer uptime feed. Zero disables the check, as Chainlink has no such feed on
    ///         Robinhood Chain yet.
    AggregatorV3Interface public sequencerFeed;

    struct Feed {
        AggregatorV3Interface aggregator;
        uint32 maxAge;
        uint256 scale;
    }

    mapping(address token => Feed) public feeds;

    event FeedSet(address indexed token, address indexed aggregator, uint32 maxAge);
    event SequencerFeedSet(address indexed feed);

    error InvalidFeed();
    error Unpriced(address token);

    constructor(
        address owner_,
        AggregatorV3Interface sequencerFeed_,
        AggregatorV3Interface usdgFeed_,
        uint32 usdgMaxAge_,
        uint8 usdgDecimals_
    ) Ownable(owner_) {
        if (address(usdgFeed_) == address(0) || usdgMaxAge_ == 0) revert InvalidFeed();
        sequencerFeed = sequencerFeed_;
        usdgFeed = usdgFeed_;
        usdgMaxAge = usdgMaxAge_;
        usdgFeedUnit = 10 ** usdgFeed_.decimals();
        usdgDecimals = usdgDecimals_;
    }

    /// @param maxAge Longest accepted gap since the last update. Robinhood equity feeds have a 24h
    ///        heartbeat and stop during market closures, so this also decides when weekends go stale.
    function setFeed(address token, AggregatorV3Interface aggregator, uint32 maxAge) external onlyOwner {
        uint256 exponent = uint256(IERC20Metadata(token).decimals()) + aggregator.decimals();
        if (maxAge == 0 || exponent < usdgDecimals) revert InvalidFeed();
        feeds[token] = Feed(aggregator, maxAge, 10 ** (exponent - usdgDecimals));
        emit FeedSet(token, address(aggregator), maxAge);
    }

    function setSequencerFeed(AggregatorV3Interface feed) external onlyOwner {
        sequencerFeed = feed;
        emit SequencerFeedSet(address(feed));
    }

    function isFresh(address token) external view returns (bool fresh) {
        (fresh,) = _read(token);
    }

    function usdgValue(address token, uint256 amount) external view returns (uint256) {
        (bool fresh, uint256 price) = _read(token);
        if (!fresh) revert Unpriced(token);
        return Math.mulDiv(amount, price, feeds[token].scale);
    }

    function fromUsdgValue(address token, uint256 usdgAmount) external view returns (uint256) {
        (bool fresh, uint256 price) = _read(token);
        if (!fresh) revert Unpriced(token);
        return Math.mulDiv(usdgAmount, feeds[token].scale, price);
    }

    /// @dev `price` is the Equity Token price in USDG, at the Equity Token feed's decimals.
    function _read(address token) private view returns (bool fresh, uint256 price) {
        Feed memory f = feeds[token];
        if (address(f.aggregator) == address(0) || !_sequencerUp() || _corporateActionPending(token)) {
            return (false, 0);
        }
        (bool ok, uint256 usd) = _latest(f.aggregator, f.maxAge);
        if (!ok) return (false, 0);
        (bool usdgOk, uint256 usdgUsd) = _latest(usdgFeed, usdgMaxAge);
        if (!usdgOk) return (false, 0);
        return (true, Math.mulDiv(usd, usdgFeedUnit, usdgUsd));
    }

    function _latest(AggregatorV3Interface feed, uint32 maxAge) private view returns (bool, uint256) {
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxAge) {
                return (false, 0);
            }
            return (true, uint256(answer));
        } catch {
            return (false, 0);
        }
    }

    function _sequencerUp() private view returns (bool) {
        AggregatorV3Interface feed = sequencerFeed;
        if (address(feed) == address(0)) return true;
        try feed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            return answer == 0 && startedAt != 0 && block.timestamp - startedAt > SEQUENCER_GRACE;
        } catch {
            return false;
        }
    }

    /// @dev Robinhood Stock Tokens expose `oraclePaused()` while a split or dividend multiplier is
    ///      being applied; prices are unreliable until it clears. Tokens without it are unaffected.
    function _corporateActionPending(address token) private view returns (bool) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return ok && data.length >= 32 && abi.decode(data, (bool));
    }
}
