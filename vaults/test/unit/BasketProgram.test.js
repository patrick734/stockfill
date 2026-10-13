const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
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
  it("refuses USDG deposits and exits while a held Vault trades off Chainlink, like the Vaults do", async function () {
    const ctx = await loadFixture(basketFixture);
    const b = ctx.basket;
    await b.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(b, USDG(5_000));
    await b.connect(ctx.alice).deposit(USDG(5_000), ctx.alice.address);
    await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(2_000));
    expect(await b.pricesUsable()).to.equal(true);
    // The AMD pool drops 20% below Chainlink while the feed still reads fresh.
    await ctx.amd.position.setSpot(USDG(120));
    expect(await ctx.amd.vault.priceUsable()).to.equal(false);
    expect(await b.pricesUsable()).to.equal(false);
    expect(await b.maxDeposit(ctx.bob)).to.equal(0n);
    expect(await b.maxWithdraw(ctx.alice)).to.equal(0n);
    await ctx.usdg.connect(ctx.bob).approve(b, USDG(1_000));
    await expect(b.connect(ctx.bob).deposit(USDG(1_000), ctx.bob.address)).to.be.reverted;
    await expect(b.connect(ctx.alice).withdraw(USDG(100), ctx.alice.address, ctx.alice.address)).to.be.reverted;
    // Leaving in kind needs no price.
    await b.connect(ctx.alice).redeemInKind(await b.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address);
    // Back within 2%: open again.
    await ctx.amd.position.setSpot(USDG(152));
    expect(await b.pricesUsable()).to.equal(true);
  });

  it("allows one USDG withdrawal from the Vaults per interval", async function () {
    const ctx = await loadFixture(basketFixture);
    const b = ctx.basket;
    await b.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(b, USDG(5_000));
    await b.connect(ctx.alice).deposit(USDG(5_000), ctx.alice.address);
    await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(2_000));
    await b.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(2_000));
    const half = (await ctx.amd.vault.balanceOf(b)) / 2n;
    await b.connect(ctx.keeper).deallocate(ctx.amd.vault, half);
    await expect(b.connect(ctx.keeper).deallocate(ctx.tsla.vault, half)).to.be.revertedWithCustomError(b, "TooSoon");
    await time.increase(30 * 60);
    await b.connect(ctx.keeper).deallocate(ctx.tsla.vault, half);
  });

  it("delists a Vault despite a dust donation, but not one it really holds", async function () {
    const ctx = await loadFixture(basketFixture);
    const b = ctx.basket;
    await b.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(b, USDG(5_000));
    await b.connect(ctx.alice).deposit(USDG(5_000), ctx.alice.address);
    await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(1_000));
    await expect(b.connect(ctx.admin).delistVault(ctx.amd.vault)).to.be.revertedWithCustomError(b, "StillHeld");
    await ctx.usdg.connect(ctx.alice).approve(ctx.tsla.vault, USDG(10));
    await ctx.tsla.vault.connect(ctx.alice).deposit(USDG(10), ctx.alice.address);
    await ctx.tsla.vault.connect(ctx.alice).transfer(b, 10n ** 9n);
    await b.connect(ctx.admin).delistVault(ctx.tsla.vault);
    expect(await b.isListed(ctx.tsla.vault)).to.equal(false);
  });
});
