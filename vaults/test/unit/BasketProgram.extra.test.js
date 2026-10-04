const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, FEED, baseFixture, deployVault } = require("./fixtures");

describe("BasketProgram (extra coverage)", function () {
  const E_ROLE = "AccessControlUnauthorizedAccount";

  async function deployBasket(ctx) {
    return ethers.deployContract("BasketStockfill", [
      ctx.usdg,
      ctx.admin.address,
      ctx.guardian.address,
      ctx.keeper.address,
      "Stockfill Basket Program",
      "pBASKET",
    ]);
  }

  async function basketFixture() {
    const ctx = await baseFixture();
    const tsla = await deployVault(ctx, "TSLA", 250);
    const basket = await deployBasket(ctx);
    await basket.connect(ctx.admin).listVault(ctx.amd.vault);
    await basket.connect(ctx.admin).listVault(tsla.vault);
    return { ...ctx, tsla, basket };
  }

  /** Open at a 100k cap and have alice deposit 10k. */
  async function openFixture() {
    const ctx = await basketFixture();
    await ctx.basket.connect(ctx.admin).setHeldValueCap(USDG(100_000));
    await ctx.usdg.connect(ctx.alice).approve(ctx.basket, USDG(10_000));
    await ctx.basket.connect(ctx.alice).deposit(USDG(10_000), ctx.alice.address);
    return ctx;
  }

  describe("constructor", function () {
    for (const who of ["admin", "guardian", "keeper"]) {
      it(`rejects a zero ${who}`, async function () {
        const ctx = await loadFixture(baseFixture);
        const F = await ethers.getContractFactory("BasketStockfill");
        const args = { admin: ctx.admin.address, guardian: ctx.guardian.address, keeper: ctx.keeper.address };
        args[who] = ethers.ZeroAddress;
        await expect(F.deploy(ctx.usdg, args.admin, args.guardian, args.keeper, "p", "p")).to.be.revertedWithCustomError(
          F,
          "InvalidConfig"
        );
      });
    }

    it("rejects guardian == admin", async function () {
      const ctx = await loadFixture(baseFixture);
      const F = await ethers.getContractFactory("BasketStockfill");
      await expect(F.deploy(ctx.usdg, ctx.admin.address, ctx.admin.address, ctx.keeper.address, "p", "p")).to.be.revertedWithCustomError(
        F,
        "InvalidConfig"
      );
    });

    it("launches closed with a 40% per-Vault ceiling", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      expect(await b.heldValueCap()).to.equal(0);
      expect(await b.maxAllocationBps()).to.equal(4000);
      expect(await b.MAX_VAULTS()).to.equal(8);
      expect(await b.decimals()).to.equal(12);
      expect(await b.vaults()).to.deep.equal([ctx.amd.vault.target, ctx.tsla.vault.target]);
    });
  });

  describe("closed / open gating", function () {
    it("rejects deposit and mint while closed", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      await ctx.usdg.connect(ctx.alice).approve(b, USDG(10));
      expect(await b.maxMint(ctx.alice)).to.equal(0);
      await expect(b.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(
        b,
        "ERC4626ExceededMaxDeposit"
      );
      await expect(b.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(b, "ERC4626ExceededMaxMint");
    });

    it("opens via the admin, mints exact shares, and closes again at the cap", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      await expect(b.connect(ctx.admin).setHeldValueCap(USDG(1_000))).to.emit(b, "HeldValueCapSet").withArgs(USDG(1_000));
      expect(await b.maxMint(ctx.alice)).to.equal(USDG(1_000) * 10n ** 6n);

      const shares = await b.previewDeposit(USDG(400));
      await ctx.usdg.connect(ctx.alice).approve(b, USDG(1_000));
      await b.connect(ctx.alice).mint(shares, ctx.alice.address);
      expect(await b.balanceOf(ctx.alice)).to.equal(shares);
      await b.connect(ctx.alice).deposit(USDG(600), ctx.alice.address);
      expect(await b.maxDeposit(ctx.alice)).to.equal(0);
      await expect(b.connect(ctx.alice).deposit(1n, ctx.alice.address)).to.be.revertedWithCustomError(b, "ERC4626ExceededMaxDeposit");
    });

    it("only the admin can open; the guardian can only lower the cap", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      await expect(b.connect(ctx.guardian).setHeldValueCap(1)).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.keeper).setHeldValueCap(1)).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.guardian).lowerHeldValueCap(1)).to.be.revertedWithCustomError(b, "InvalidConfig");
      await b.connect(ctx.admin).setHeldValueCap(USDG(100));
      await expect(b.connect(ctx.admin).lowerHeldValueCap(USDG(50))).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.guardian).lowerHeldValueCap(USDG(50))).to.emit(b, "HeldValueCapSet").withArgs(USDG(50));
      await b.connect(ctx.guardian).lowerHeldValueCap(0);
      expect(await b.maxDeposit(ctx.alice)).to.equal(0);
    });
  });

  describe("pause", function () {
    it("only the guardian pauses; only the admin unpauses", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      await expect(b.connect(ctx.admin).pause()).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.keeper).pause()).to.be.revertedWithCustomError(b, E_ROLE);
      await b.connect(ctx.guardian).pause();
      await expect(b.connect(ctx.guardian).unpause()).to.be.revertedWithCustomError(b, E_ROLE);
      await b.connect(ctx.admin).unpause();
      expect(await b.paused()).to.equal(false);
    });

    it("stops deposit, mint and allocate but leaves every exit and deallocate open", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(2_000));
      await b.connect(ctx.guardian).pause();

      expect(await b.maxDeposit(ctx.alice)).to.equal(0);
      await ctx.usdg.connect(ctx.alice).approve(b, USDG(10));
      await expect(b.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(b, "EnforcedPause");
      await expect(b.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(b, "EnforcedPause");
      await expect(b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(1))).to.be.revertedWithCustomError(b, "EnforcedPause");

      await b.connect(ctx.keeper).deallocate(ctx.amd.vault, (await ctx.amd.vault.balanceOf(b)) / 2n);
      await b.connect(ctx.alice).withdraw(USDG(1_000), ctx.alice.address, ctx.alice.address);
      await b.connect(ctx.alice).redeem((await b.balanceOf(ctx.alice)) / 4n, ctx.alice.address, ctx.alice.address);
      await b.connect(ctx.alice).redeemInKind(await b.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address);
      expect(await b.totalSupply()).to.equal(0);
    });
  });

  describe("allocation across Vaults", function () {
    it("splits a deposit across Vaults and emits Allocated", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      const shares = await ctx.amd.vault.previewDeposit(USDG(3_000));
      await expect(b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(3_000)))
        .to.emit(b, "Allocated")
        .withArgs(ctx.amd.vault.target, USDG(3_000), shares);
      await b.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(2_500));

      expect(await ctx.usdg.balanceOf(b)).to.equal(USDG(4_500));
      expect(await ctx.amd.vault.convertToAssets(await ctx.amd.vault.balanceOf(b))).to.be.closeTo(USDG(3_000), 1n);
      expect(await ctx.tsla.vault.convertToAssets(await ctx.tsla.vault.balanceOf(b))).to.be.closeTo(USDG(2_500), 1n);
      expect(await b.totalAssets()).to.be.closeTo(USDG(10_000), 2n);
      expect(await ctx.usdg.allowance(b, ctx.amd.vault)).to.equal(0);
    });

    it("allows exactly the ceiling and rejects one unit more", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(4_000));
      // 4,000 of 10,000 in a Vault is exactly 40%; one more wei in another Vault breaches it
      await expect(b.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(4_000) + 1n)).to.be.revertedWithCustomError(b, "OverAllocated");
    });

    it("the admin can change the ceiling within (0, 100%]", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await expect(b.connect(ctx.admin).setMaxAllocationBps(0)).to.be.revertedWithCustomError(b, "InvalidConfig");
      await expect(b.connect(ctx.admin).setMaxAllocationBps(10_001)).to.be.revertedWithCustomError(b, "InvalidConfig");
      await expect(b.connect(ctx.guardian).setMaxAllocationBps(5_000)).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.admin).setMaxAllocationBps(10_000)).to.emit(b, "MaxAllocationSet").withArgs(10_000);
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(10_000));
      expect(await ctx.usdg.balanceOf(b)).to.equal(0);
      await b.connect(ctx.admin).setMaxAllocationBps(1);
      expect(await b.maxAllocationBps()).to.equal(1);
    });

    it("rejects allocate/deallocate for an unlisted Vault and for non-keepers", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      const nvda = await deployVault(ctx, "NVDA", 180);
      await expect(b.connect(ctx.keeper).allocate(nvda.vault, USDG(1))).to.be.revertedWithCustomError(b, "NotListed");
      await expect(b.connect(ctx.keeper).deallocate(nvda.vault, 1n)).to.be.revertedWithCustomError(b, "NotListed");
      await expect(b.connect(ctx.admin).allocate(ctx.amd.vault, USDG(1))).to.be.revertedWithCustomError(b, E_ROLE);
      await expect(b.connect(ctx.alice).deallocate(ctx.amd.vault, 1n)).to.be.revertedWithCustomError(b, E_ROLE);
    });

    it("deallocates Vault shares back into idle USDG", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(4_000));
      const shares = await ctx.amd.vault.balanceOf(b);
      await expect(b.connect(ctx.keeper).deallocate(ctx.amd.vault, shares)).to.emit(b, "Deallocated");
      expect(await ctx.amd.vault.balanceOf(b)).to.equal(0);
      expect(await ctx.usdg.balanceOf(b)).to.be.closeTo(USDG(10_000), 1n);
    });
  });

  describe("USDG exits and price freshness", function () {
    it("serves withdraw/redeem from idle USDG only", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(4_000));
      await b.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(4_000));
      expect(await b.maxWithdraw(ctx.alice)).to.equal(USDG(2_000));
      const maxR = await b.maxRedeem(ctx.alice);
      expect(maxR).to.be.lt(await b.balanceOf(ctx.alice));

      await expect(b.connect(ctx.alice).withdraw(USDG(2_000) + 1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        b,
        "ERC4626ExceededMaxWithdraw"
      );
      await expect(b.connect(ctx.alice).redeem(maxR + 1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        b,
        "ERC4626ExceededMaxRedeem"
      );
      const before = await ctx.usdg.balanceOf(ctx.alice);
      await b.connect(ctx.alice).redeem(maxR, ctx.alice.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.be.closeTo(USDG(2_000), 1n);
    });

    it("maxRedeem is bounded by the holder's balance when idle USDG is ample", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await ctx.usdg.connect(ctx.bob).approve(b, USDG(100));
      await b.connect(ctx.bob).deposit(USDG(100), ctx.bob.address);
      expect(await b.maxRedeem(ctx.bob)).to.equal(await b.balanceOf(ctx.bob));
      expect(await b.maxWithdraw(ctx.bob)).to.be.closeTo(USDG(100), 1n);
    });

    it("a stale price on a held Vault closes deposits and USDG exits; a stale unheld Vault does not", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(2_000));

      // TSLA is listed but not held: its staleness does not matter.
      await ctx.tsla.feed.set(FEED(250), 1, 1);
      expect(await b.allPricesFresh()).to.equal(true);
      expect(await b.maxDeposit(ctx.alice)).to.be.gt(0);

      // AMD is held: staleness closes deposits and USDG exits.
      await ctx.amd.feed.set(FEED(150), 1, 1);
      expect(await b.allPricesFresh()).to.equal(false);
      expect(await b.maxDeposit(ctx.alice)).to.equal(0);
      expect(await b.maxMint(ctx.alice)).to.equal(0);
      expect(await b.maxWithdraw(ctx.alice)).to.equal(0);
      expect(await b.maxRedeem(ctx.alice)).to.equal(0);
      await expect(b.connect(ctx.alice).withdraw(1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        b,
        "ERC4626ExceededMaxWithdraw"
      );

      // In-kind still works with no price.
      await b.connect(ctx.alice).redeemInKind(await b.balanceOf(ctx.alice), ctx.bob.address, ctx.alice.address);
      expect(await ctx.amd.vault.balanceOf(ctx.bob)).to.be.gt(0);
    });
  });

  describe("redeemInKind", function () {
    it("rejects zero shares", async function () {
      const ctx = await loadFixture(openFixture);
      await expect(ctx.basket.connect(ctx.alice).redeemInKind(0, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        ctx.basket,
        "InvalidConfig"
      );
    });

    it("needs and spends allowance for a third party", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      const shares = (await b.balanceOf(ctx.alice)) / 2n;
      await expect(b.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address)).to.be.revertedWithCustomError(
        b,
        "ERC20InsufficientAllowance"
      );
      await b.connect(ctx.alice).approve(ctx.bob, shares);
      await expect(b.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address))
        .to.emit(b, "RedeemedInKind")
        .withArgs(ctx.alice.address, ctx.bob.address, shares, USDG(5_000));
      expect(await b.allowance(ctx.alice, ctx.bob)).to.equal(0);
    });

    it("returns only Vault shares when nothing is idle, skipping Vaults not held", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await b.connect(ctx.admin).setMaxAllocationBps(10_000);
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(10_000));
      const vaultShares = await ctx.amd.vault.balanceOf(b);
      const usdgBefore = await ctx.usdg.balanceOf(ctx.bob);

      await expect(b.connect(ctx.alice).redeemInKind(await b.balanceOf(ctx.alice), ctx.bob.address, ctx.alice.address))
        .to.emit(b, "RedeemedInKind")
        .withArgs(ctx.alice.address, ctx.bob.address, await b.balanceOf(ctx.alice), 0);
      expect(await ctx.usdg.balanceOf(ctx.bob)).to.equal(usdgBefore);
      expect(await ctx.amd.vault.balanceOf(ctx.bob)).to.equal(vaultShares);
      expect(await ctx.tsla.vault.balanceOf(ctx.bob)).to.equal(0);
    });

    it("rounds pro-rata slices down, so remaining holders are not diluted", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      await ctx.usdg.connect(ctx.bob).approve(b, USDG(3_333));
      await b.connect(ctx.bob).deposit(USDG(3_333), ctx.bob.address);
      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(3_333));
      await b.connect(ctx.keeper).allocate(ctx.tsla.vault, USDG(2_222));

      const supply = await b.totalSupply();
      const idle = await ctx.usdg.balanceOf(b);
      const amdHeld = await ctx.amd.vault.balanceOf(b);
      const odd = (await b.balanceOf(ctx.alice)) / 7n + 3n;
      const uBefore = await ctx.usdg.balanceOf(ctx.carol);
      await b.connect(ctx.alice).redeemInKind(odd, ctx.carol.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.carol)) - uBefore).to.equal((idle * odd) / supply);
      expect(await ctx.amd.vault.balanceOf(ctx.carol)).to.equal((amdHeld * odd) / supply);

      // A 1-share redemption pays nothing yet burns the share.
      const aBefore = await b.balanceOf(ctx.alice);
      await expect(b.connect(ctx.alice).redeemInKind(1n, ctx.carol.address, ctx.alice.address))
        .to.emit(b, "RedeemedInKind")
        .withArgs(ctx.alice.address, ctx.carol.address, 1n, 0);
      expect(await b.balanceOf(ctx.alice)).to.equal(aBefore - 1n);
    });
  });

  describe("listing", function () {
    it("rejects duplicates, a foreign-asset Vault and non-admins", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      await expect(b.connect(ctx.admin).listVault(ctx.amd.vault)).to.be.revertedWithCustomError(b, "InvalidConfig");
      await expect(b.connect(ctx.guardian).listVault(ctx.amd.vault)).to.be.revertedWithCustomError(b, E_ROLE);

      const other = await ethers.deployContract("MockERC20", ["Other dollar", "ODL", 6]);
      const foreign = await ethers.deployContract("VaultStockfill", [
        {
          usdg: other.target,
          equityToken: ctx.amd.equity.target,
          position: ctx.amd.position.target,
          oracle: ctx.oracle.target,
          swapAdapter: ctx.swap.target,
          feeRouter: ctx.feeRouter.target,
          admin: ctx.admin.address,
          guardian: ctx.guardian.address,
          keeper: ctx.keeper.address,
          heldValueCap: 0,
        },
        "Foreign",
        "wF",
      ]);
      await expect(b.connect(ctx.admin).listVault(foreign)).to.be.revertedWithCustomError(b, "InvalidConfig");
    });

    it("caps the list at MAX_VAULTS", async function () {
      const ctx = await loadFixture(basketFixture);
      const b = ctx.basket;
      for (let i = 0; i < 6; i++) {
        const w = await deployVault(ctx, `T${i}`, 100 + i);
        await expect(b.connect(ctx.admin).listVault(w.vault)).to.emit(b, "VaultListed").withArgs(w.vault.target);
      }
      expect((await b.vaults()).length).to.equal(8);
      const ninth = await deployVault(ctx, "T9", 99);
      await expect(b.connect(ctx.admin).listVault(ninth.vault)).to.be.revertedWithCustomError(b, "InvalidConfig");
    });

    it("delists with swap-and-pop, refusing unlisted and still-held Vaults", async function () {
      const ctx = await loadFixture(openFixture);
      const b = ctx.basket;
      const nvda = await deployVault(ctx, "NVDA", 180);
      await b.connect(ctx.admin).listVault(nvda.vault);
      expect(await b.vaults()).to.deep.equal([ctx.amd.vault.target, ctx.tsla.vault.target, nvda.vault.target]);

      const unlisted = await deployVault(ctx, "AAPL", 200);
      await expect(b.connect(ctx.admin).delistVault(unlisted.vault)).to.be.revertedWithCustomError(b, "NotListed");
      await expect(b.connect(ctx.guardian).delistVault(ctx.amd.vault)).to.be.revertedWithCustomError(b, E_ROLE);

      await b.connect(ctx.keeper).allocate(ctx.amd.vault, USDG(1_000));
      await expect(b.connect(ctx.admin).delistVault(ctx.amd.vault)).to.be.revertedWithCustomError(b, "StillHeld");
      await b.connect(ctx.keeper).deallocate(ctx.amd.vault, await ctx.amd.vault.balanceOf(b));

      await expect(b.connect(ctx.admin).delistVault(ctx.amd.vault)).to.emit(b, "VaultDelisted").withArgs(ctx.amd.vault.target);
      expect(await b.isListed(ctx.amd.vault)).to.equal(false);
      expect(await b.vaults()).to.deep.equal([nvda.vault.target, ctx.tsla.vault.target]);

      // delisting the last element
      await b.connect(ctx.admin).delistVault(ctx.tsla.vault);
      expect(await b.vaults()).to.deep.equal([nvda.vault.target]);
      // and it can be listed again
      await b.connect(ctx.admin).listVault(ctx.amd.vault);
      expect(await b.vaults()).to.deep.equal([nvda.vault.target, ctx.amd.vault.target]);
    });
  });
});
