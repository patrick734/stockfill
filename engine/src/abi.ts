import { parseAbi } from "viem";

export const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
]);

export const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
]);

export const poolManagerAbi = parseAbi([
  "function extsload(bytes32[] slots) view returns (bytes32[])",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const hopTuple = "(uint8 kind, address tokenOut, uint24 fee, int24 tickSpacing, address hooks)";

export const quoterAbi = parseAbi([
  `function quotePath(address tokenIn, ${hopTuple}[] hops, uint256 amountIn) returns (uint256 amountOut, uint256[] hopOut)`,
  `function quotePathExactOut(address tokenIn, ${hopTuple}[] hops, uint256 amountOut) returns (uint256 amountIn, uint256[] hopIn)`,
  `function quoteMany(address tokenIn, ${hopTuple}[][] paths, uint256[][] amounts) returns (uint256[][] outs)`,
  `function quoteManyExactOut(address tokenIn, ${hopTuple}[][] paths, uint256[][] amounts) returns (uint256[][] ins)`,
]);

const legTuple = `(uint256 amount, ${hopTuple}[] hops)`;
const tradeTuple = "(address tokenIn, address tokenOut, bool exactOut, uint256 amountLimit, address recipient, uint256 deadline)";

export const routerAbi = parseAbi([
  `function swap(address tokenIn, address tokenOut, ${legTuple}[] legs, uint256 minAmountOut, address recipient, uint256 deadline) payable returns (uint256 amountOut)`,
  `function swapExactOut(address tokenIn, address tokenOut, ${legTuple}[] legs, uint256 maxAmountIn, address recipient, uint256 deadline) payable returns (uint256 amountIn)`,
  `function swapWithPermit(${tradeTuple} t, ${legTuple}[] legs, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) permit) returns (uint256 amountIn, uint256 amountOut)`,
  `function swapWithPermit2(${tradeTuple} t, ${legTuple}[] legs, (uint256 amount, uint256 nonce, uint256 deadline, bytes signature) permit) returns (uint256 amountIn, uint256 amountOut)`,
  "function permit2() view returns (address)",
  "event Swapped(address indexed sender, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 legs)",
  "error Expired()",
  "error Reentered()",
  "error BadRoute()",
  "error BadHop(uint256 leg, uint256 hop)",
  "error BadValue()",
  "error BadRecipient()",
  "error AmountTooLarge()",
  "error InputNotReceived()",
  "error OutputNotReceived()",
  "error NoPool(address tokenA, address tokenB, uint24 fee)",
  "error PartialFill()",
  "error UnauthorizedCallback()",
  "error TooLittleReceived(uint256 amountOut, uint256 minAmountOut)",
  "error TooMuchRequested(uint256 amountIn, uint256 maxAmountIn)",
  "error TransferFailed()",
  "error UnexpectedETH()",
  "error Permit2Unavailable()",
]);

export const permitAbi = parseAbi([
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function nonces(address owner) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function version() view returns (string)",
]);
