// Plugs $FILL into a deployment made before the token launched: calls BuyBurn.setFillToken once, from
// the deployer (the recorded fillTokenSetter), after checking the token. Permanent once sent.
//   FILL_TOKEN_ADDRESS=0x... npx hardhat run scripts/set-fill-token.js --network robinhood
// Updates deployments/<network>.json so the app and keeper pick the address up.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

// Checks `address` is a usable $FILL: a contract, 18 decimals, and a real burn(uint256).
async function checkFillToken(address) {
  if (!address || !ethers.isAddress(address)) throw new Error("FILL_TOKEN_ADDRESS is not a valid address");
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at ${address}`);
  const token = await ethers.getContractAt("TokenStockfill", address);
  const [symbol, decimals, supply] = await Promise.all([token.symbol(), token.decimals(), token.totalSupply()]);
  if (decimals !== 18n) throw new Error(`$FILL must have 18 decimals, got ${decimals}`);
  const probe = (amount) =>
    ethers.provider.call({ from: "0x0000000000000000000000000000000000000001", to: address, data: token.interface.encodeFunctionData("burn", [amount]) }).then(() => true, () => false);
  // A real burn succeeds for 0 and refuses more than the caller holds; a fallback would accept both.
  if (!(await probe(0n)) || (await probe(10n ** 30n))) throw new Error(`${symbol} at ${address} has no working burn(uint256), which BuyBurn needs`);
  return { symbol, supply };
}

// Sets $FILL on the deployment in `file` from `signer`. Returns the transaction hash.
async function setFillToken(file, address, signer) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const drawdown = await ethers.getContractAt("BuyBurnStockfill", d.buyBurn, signer);
  const [current, setter] = await Promise.all([drawdown.fillToken(), drawdown.fillTokenSetter()]);
  if (current !== ethers.ZeroAddress) {
    if (current.toLowerCase() === address.toLowerCase()) {
      console.log(`$FILL is already set to ${current}. Nothing to send.`);
      if (d.fillToken !== current) {
        d.fillToken = current; // e.g. an earlier attempt mined but its confirmation was lost
        fs.writeFileSync(file, JSON.stringify(d, null, 2));
        console.log(`Updated ${path.relative(process.cwd(), file)}.`);
      }
      return null;
    }
    throw new Error(`$FILL is already set to ${current} and can never change.`);
  }
  if (setter.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`Only ${setter} can set $FILL; this key is ${signer.address}. Use the deployer wallet.`);
  }
  const { symbol, supply } = await checkFillToken(address);
  console.log(`Setting $FILL to ${symbol} ${address} (supply ${ethers.formatEther(supply)}). This is permanent.`);
  const tx = await drawdown.setFillToken(address);
  await tx.wait();
  d.fillToken = ethers.getAddress(address);
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`Done: ${tx.hash}\nUpdated ${path.relative(process.cwd(), file)}.`);
  return tx.hash;
}

async function main() {
  const label = network.name === "hardhat" ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment file ${file}. Deploy first.`);
  const [signer] = await ethers.getSigners();
  await setFillToken(file, process.env.FILL_TOKEN_ADDRESS, signer);
}

module.exports = { checkFillToken, setFillToken };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
