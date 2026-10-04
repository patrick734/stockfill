const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, baseFixture, deployVault } = require("./fixtures");

describe("BasketStockfill", function () {
  async function basketFixture() {
    const ctx = await baseFixture();
    const tsla = await deployVault(ctx, "TSLA", 250);
    const basket = await ethers.deployContract("BasketStockfill", [
      ctx.usdg,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      "Stockfill Basket Program",
      "pBASKET",
    ]);
    await basket.connect(ctx.admin).listVault(ctx.amd.vault);
    await basket.connect(ctx.admin).listVault(tsla.vault);
    return { ...ctx, tsla, basket };
  }

  it("launches closed until the admin sets a Held Value cap", async function () {
    const ctx = await loadFixture(basketFixture);
    expect(await ctx.basket.maxDeposit(ctx.alice)).to.equal(0);
    await ctx.basket.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    expect(await ctx.basket.maxDeposit(ctx.alice)).to.equal(USDG(100_000));
  });

  it("spreads capital across Vaults within the allocation ceiling", async function () {
    const ctx = await loadFixture(basketFixture);
    await ctx.basket.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(ctx.basket, USDG(10_000));
    await ctx.basket.connect(ctx.alice).deposit(USDG(10_000), ctx.alice.address);

    await ctx.basket.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(4_000));
    await ctx.basket.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(4_000));
    await expect(ctx.basket.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(1_000))).to.be.revertedWithCustomError(
      ctx.basket,
      "OverAllocated"
    );
    expect(await ctx.basket.totalAssets()).to.be.closeTo(USDG(10_000), 2n);
    expect(await ctx.basket.maxWithdraw(ctx.alice)).to.equal(USDG(2_000));
  });

  it("redeems in kind into idle USDG plus Vault shares", async function () {
    const ctx = await loadFixture(basketFixture);
    await ctx.basket.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(ctx.basket, USDG(10_000));
    await ctx.basket.connect(ctx.alice).deposit(USDG(10_000), ctx.alice.address);
    await ctx.basket.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(4_000));

    const half = (await ctx.basket.balanceOf(ctx.alice)) / 2n;
    await ctx.basket.connect(ctx.alice).redeemInKind(half, ctx.bob.address, ctx.alice.address);
    expect(await ctx.usdg.balanceOf(ctx.bob)).to.be.closeTo(USDG(1_000_000 + 3_000), 2n);
    expect(await ctx.amd.vault.convertToAssets(await ctx.amd.vault.balanceOf(ctx.bob))).to.be.closeTo(USDG(2_000), 2n);
  });
});
