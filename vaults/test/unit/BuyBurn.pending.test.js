// Deploying before $FILL exists: BuyBurn starts without a token, and `fillTokenSetter` sets it exactly once.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, baseFixture } = require("./fixtures");

describe("BuyBurn deployed before $FILL", function () {
  async function pending() {
    const ctx = await baseFixture();
    const [, , , , , , setter] = await ethers.getSigners();
    const drawdown = await ethers.deployContract("BuyBurnStockfill", [
      ethers.ZeroAddress,
      ctx.swap,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      0,
      setter.address,
    ]);
    await drawdown.connect(ctx.admin).setInputLimit(ctx.usdg, USDG(1_000));
    await ctx.usdg.mint(drawdown, USDG(500)); // fees routed in before $FILL exists
    return { ...ctx, drawdown, setter };
  }

  describe("constructor", function () {
    it("needs either a token or a setter", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("BuyBurnStockfill");
      const base = [ctx.swap.target, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0];
      await expect(F.deploy(ethers.ZeroAddress, ...base, ethers.ZeroAddress)).to.be.revertedWithCustomError(F, "InvalidConfig");
    });

    it("starts empty with the setter recorded", async function () {
      const { drawdown, setter } = await loadFixture(pending);
      expect(await drawdown.fillToken()).to.equal(ethers.ZeroAddress);
      expect(await drawdown.fillTokenSetter()).to.equal(setter.address);
    });

    it("ignores the setter when the token is fixed at deployment", async function () {
      const ctx = await loadFixture(baseFixture);
      const d = await ethers.deployContract("BuyBurnStockfill", [
        ctx.fillToken, ctx.swap, ctx.admin.address, ctx.guardian.address, ctx.keeper.address, 0, ctx.alice.address,
      ]);
      expect(await d.fillToken()).to.equal(ctx.fillToken.target);
      expect(await d.fillTokenSetter()).to.equal(ethers.ZeroAddress);
      await expect(d.connect(ctx.alice).setFillToken(ctx.usdg)).to.be.revertedWithCustomError(d, "Unauthorized");
    });
  });

  describe("before the token is set", function () {
    it("holds fees and refuses to draw down", async function () {
      const { drawdown, keeper, usdg } = await loadFixture(pending);
      await expect(drawdown.connect(keeper).drawdown(usdg, USDG(100), 1n, "0x")).to.be.revertedWithCustomError(drawdown, "FillTokenUnset");
      expect(await usdg.balanceOf(drawdown)).to.equal(USDG(500));
    });

    it("treats retireHeld as a no-op", async function () {
      const { drawdown } = await loadFixture(pending);
      await expect(drawdown.retireHeld()).to.not.be.reverted;
      expect(await drawdown.totalRetired()).to.equal(0n);
    });
  });

  describe("setFillToken", function () {
    it("only the setter can call it", async function () {
      const { drawdown, admin, alice, fillToken } = await loadFixture(pending);
      await expect(drawdown.connect(alice).setFillToken(fillToken)).to.be.revertedWithCustomError(drawdown, "Unauthorized");
      // Not even the admin: the setter is the only key with this power.
      await expect(drawdown.connect(admin).setFillToken(fillToken)).to.be.revertedWithCustomError(drawdown, "Unauthorized");
    });

    it("rejects the zero address", async function () {
      const { drawdown, setter } = await loadFixture(pending);
      await expect(drawdown.connect(setter).setFillToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(drawdown, "InvalidConfig");
    });

    it("sets the token once and can never change it", async function () {
      const { drawdown, setter, fillToken, usdg } = await loadFixture(pending);
      await expect(drawdown.connect(setter).setFillToken(fillToken)).to.emit(drawdown, "FillTokenSet").withArgs(fillToken.target);
      expect(await drawdown.fillToken()).to.equal(fillToken.target);
      await expect(drawdown.connect(setter).setFillToken(usdg)).to.be.revertedWithCustomError(drawdown, "FillTokenAlreadySet");
      await expect(drawdown.connect(setter).setFillToken(fillToken)).to.be.revertedWithCustomError(drawdown, "FillTokenAlreadySet");
    });

    it("then spends the fees that waited and burns the $FILL", async function () {
      const { drawdown, setter, keeper, fillToken, usdg } = await loadFixture(pending);
      await drawdown.connect(setter).setFillToken(fillToken);
      const supply = await fillToken.totalSupply();
      await expect(drawdown.connect(keeper).drawdown(usdg, USDG(500), 1n, "0x")).to.emit(drawdown, "Retired");
      const retired = await drawdown.totalRetired();
      expect(retired).to.be.gt(0n);
      expect(await fillToken.totalSupply()).to.equal(supply - retired);
      expect(await usdg.balanceOf(drawdown)).to.equal(0n);
    });
  });
});
