/**
 * jbosley-bot
 *
 * A wave-surfing, GuessFactor-gunning duelist built to hunt other wave surfers.
 * It reads its opponent live and lets the fight pick its own weapon:
 *
 *   • Movement — depth-2 wave surfing: it detects each enemy bullet as an
 *     expanding wave, simulates orbit/flip/brake with exact game physics across
 *     the next TWO waves, and slides to the least-dangerous spot. An adaptive
 *     flattener denies statistical guns any favourite angle to exploit.
 *   • Gun — an 8-slot virtual-gun array (head-on, circular, stable GF-KNN,
 *     recency-weighted anti-surf GF-KNN, and three surf-simulation guns that
 *     model the enemy dodging our bullet). Whichever gun is landing most
 *     drives real fire.
 *   • Mirror Mind — runs the standard GF-KNN gun recipe against OUR OWN
 *     movement, so every incoming wave carries a prediction of where the
 *     enemy's gun aimed — and the surfer dodges precisely that.
 *   • HUD — paints incoming waves, the mirror's predicted aim points, the
 *     dodge sweep, the firing line, and a live read of the opponent. Enable
 *     graphical debugging in the GUI to watch it think.
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
  BulletHitBotEvent,
  WonRoundEvent,
} from "@robocode.dev/tank-royale-bot-api";
import { absoluteBearing, normalizeRelative } from "./src/geom.ts";
import { GameState } from "./src/state.ts";
import { Gun } from "./src/gun.ts";
import { Surfer } from "./src/surf.ts";
import type { MyBullet } from "./src/surf.ts";
import { bulletSpeed } from "./src/physics.ts";
import { dist } from "./src/geom.ts";
import { appendFileSync } from "node:fs";
import { selectPower } from "./src/power.ts";
import { paintColors, paintHud } from "./src/hud.ts";
import { MirrorMind } from "./src/mirror.ts";
import { PuppetMind } from "./src/puppet.ts";

class JbosleyBot extends Bot {
  private readonly gs = new GameState();
  private readonly gun = new Gun();
  private readonly surfer = new Surfer();
  private readonly mirror = new MirrorMind();
  private readonly puppet = new PuppetMind();

  private prevEnemyEnergy = 100;
  private pendingDamage = 0; // our bullet damage to the enemy not yet reflected in scans
  private pendingEnemyGain = 0; // energy the enemy gained by hitting us (masks its fire cost)
  private myBullets: MyBullet[] = [];

  // Opponent profiling (drives the HUD read and a light power bias).
  private shotsFired = 0;
  private shotsHit = 0;
  private enemyShots = 0;
  private lateralSum = 0;
  private samples = 0;
  private dbgLines = 0;

  static main(): void {
    new JbosleyBot().start();
  }

  override run(): void {
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    paintColors(this);

    this.gs.arenaWidth = this.getArenaWidth();
    this.gs.arenaHeight = this.getArenaHeight();
    this.gs.onRoundStart();
    this.gun.onRoundStart();
    this.surfer.onRoundStart();
    this.mirror.onRoundStart();
    this.puppet.onRoundStart();
    // Puppet gun benched: reconstruction drift made it a coin-flip gun in
    // testing. The empirical surf-option guns cover the same ground better.
    this.gun.puppet = null;
    this.prevEnemyEnergy = 100;
    this.pendingDamage = 0;
    this.myBullets = [];

    while (this.isRunning()) {
      this.turnRadarRight(360); // sweep until we lock on
    }
    this.logRound("END");
  }

  override onScannedBot(e: ScannedBotEvent): void {
    const t = this.getTurnNumber();
    this.gs.arenaWidth = this.getArenaWidth();
    this.gs.arenaHeight = this.getArenaHeight();
    this.gs.updateMe({
      x: this.getX(),
      y: this.getY(),
      energy: this.getEnergy(),
      direction: this.getDirection(),
      speed: this.getSpeed(),
      time: t,
    });
    const hadSeen = this.gs.seenEnemy;
    this.gs.updateEnemy({
      x: e.x,
      y: e.y,
      energy: e.energy,
      direction: e.direction,
      speed: e.speed,
      time: t,
    });

    // --- learn from our in-flight waves reaching the enemy ---------------
    this.gun.update(this.gs);

    // --- detect an enemy shot ---------------------------------------------
    // Full energy ledger: fire cost = (previous - current) - damage we dealt
    // + energy they GAINED by hitting us. Without the gain term, an enemy shot
    // fired the same tick their bullet lands on us is invisible — an unsurfed
    // bullet straight into our hull.
    if (hadSeen) {
      const drop = this.prevEnemyEnergy - e.energy - this.pendingDamage + this.pendingEnemyGain;
      if (drop >= 0.09 && drop <= 3.01) {
        // The wave left last tick — attach the mirror predictions from last tick.
        this.surfer.detectWave(this.gs, drop, this.mirror.lastLaunchPredictions);
        this.enemyShots++;
        this.gs.lastEnemyBulletPower = drop;
      }
    }
    this.prevEnemyEnergy = e.energy;
    this.pendingDamage = 0;
    this.pendingEnemyGain = 0;

    // Advance the Mirror Mind (after wave detection — its predictions are
    // consumed with a one-tick lag, matching when the enemy actually fired).
    this.mirror.update(this.gs, this.gs.lastEnemyBulletPower);
    // Advance the Puppet (rebuilds the enemy surfer's training data).
    this.puppet.update(this.gs);

    // profiling sample
    this.lateralSum += Math.abs(this.gs.enemyLateralSpeed);
    this.samples++;

    // --- radar: tight overshoot lock -------------------------------------
    const radarAbs = absoluteBearing(this.getX(), this.getY(), e.x, e.y);
    const radarDelta = normalizeRelative(radarAbs - this.getRadarDirection());
    this.setTurnRadarLeft(radarDelta * 2);

    // --- gun: pick power, aim via the winning virtual gun, fire ----------
    const power = selectPower(this.gs);
    const aimAngle = this.gun.aim(this.gs, power);
    const gunDelta = normalizeRelative(aimAngle - this.getGunDirection());
    this.setTurnGunLeft(gunDelta);

    const distance = this.gs.distanceToEnemy();
    const aimTol = Math.atan2(18, Math.max(distance, 1)) * (180 / Math.PI) + 2;
    let fired = false;
    if (this.getGunHeat() === 0 && this.getEnergy() > power + 0.2 && Math.abs(gunDelta) < aimTol) {
      if (this.setFire(power)) {
        this.gun.registerShot(this.gs, power);
        this.puppet.onMyShot(this.gs, power);
        this.shotsFired++;
        this.myBullets.push({ fireTime: t, power, x: this.getX(), y: this.getY(), dir: aimAngle });
        fired = true;
      }
    }
    // Learn every turn, not just when we shoot.
    if (!fired) this.gun.registerTickWave(this.gs, power);

    // Prune our bullets that have already reached the enemy.
    this.myBullets = this.myBullets.filter((b) => {
      const radius = (t - b.fireTime) * bulletSpeed(b.power);
      return radius < dist(b.x, b.y, e.x, e.y) + 40 && t - b.fireTime < 120;
    });

    // --- movement: wave surfing ------------------------------------------
    const cmd = this.surfer.update(this.gs, this.myBullets);
    this.setMaxSpeed(cmd.maxSpeed);
    this.setTurnLeft(cmd.turn);
    this.setForward(cmd.drive);

    // --- style: paint the show -------------------------------------------
    try {
      paintHud(this.getGraphics(), this.gs, this.surfer, this.readOpponent(), this.gun.bestGunName(), aimAngle);
    } catch (err) {
      if (process.env.JBOSLEY_DEBUG && this.dbgLines < 620) appendFileSync(process.env.JBOSLEY_DEBUG, `HUDERR ${String(err)}\n`);
    }

    if (process.env.JBOSLEY_DEBUG && this.dbgLines < 600) {
      this.dbgLines++;
      const d = this.gs.distanceToEnemy();
      appendFileSync(
        process.env.JBOSLEY_DEBUG,
        `R${this.getRoundNumber()} T${t} myE=${this.getEnergy().toFixed(0)} enE=${e.energy.toFixed(0)} d=${d.toFixed(0)} spd=${this.getSpeed().toFixed(1)} hitByEn=${this.surfer.hitCount()} waves=${this.surfer.activeWaves().length} od=${this.surfer.lastChosenDir}\n`,
      );
    }
  }

  private readOpponent(): string {
    if (this.samples < 25) return "READING…";
    const avgLat = this.lateralSum / Math.max(1, this.samples);
    const hitRate = this.shotsFired > 4 ? this.shotsHit / this.shotsFired : -1;
    if (this.enemyShots < 2 && this.samples > 60) return "PASSIVE";
    if (hitRate >= 0 && hitRate < 0.11 && avgLat > 3) return "SURFER";
    if (hitRate >= 0.28) return "EASY MARK";
    if (avgLat > 3) return "DODGER";
    return "DUELIST";
  }

  override onBulletHitBot(e: BulletHitBotEvent): void {
    this.pendingDamage += e.damage;
    this.shotsHit++;
    this.puppet.onMyBulletHit(this.gs);
  }

  override onHitByBullet(e: HitByBulletEvent): void {
    this.surfer.onHitByBullet(e.bullet.power, this.getX(), this.getY(), this.getTurnNumber());
    this.pendingEnemyGain += 3 * e.bullet.power; // they earned energy — don't let it hide their next shot
  }

  override onHitWall(_e: HitWallEvent): void {
    // Wall smoothing should prevent this; nothing extra needed.
  }

  override onHitBot(e: HitBotEvent): void {
    // Rammed — nudge away so we don't get pinned, surfing resumes next turn.
    if (e.isRammed) this.setBack(40);
  }

  override onWonRound(_e: WonRoundEvent): void {
    this.logRound("WON");
    this.setTurnLeft(360); // victory spin
  }

  override onDeath(): void {
    if (process.env.JBOSLEY_DEBUG)
      appendFileSync(
        process.env.JBOSLEY_DEBUG,
        `DEATH r${this.getRoundNumber()} t${this.getTurnNumber()} enemyE=${this.gs.enemy.energy.toFixed(1)} dist=${this.gs.distanceToEnemy().toFixed(0)}\n`,
      );
  }

  override onRoundEnded(e: { turnNumber?: number }): void {
    if (!process.env.JBOSLEY_DEBUG) return;
    const hr = this.shotsFired ? ((this.shotsHit / this.shotsFired) * 100).toFixed(0) : "?";
    appendFileSync(
      process.env.JBOSLEY_DEBUG,
      `ROUNDEND r${this.getRoundNumber()} myE=${this.getEnergy().toFixed(0)} enE=${this.gs.enemy.energy.toFixed(1)} myHit=${hr}%(${this.shotsHit}/${this.shotsFired}) gun=${this.gun.bestGunName()} ${this.surfer.debug()}\n`,
    );
  }

  private logRound(tag: string): void {
    const dbg = process.env.JBOSLEY_DEBUG;
    if (!dbg) return;
    const hr = this.shotsFired ? ((this.shotsHit / this.shotsFired) * 100).toFixed(0) : "?";
    const line = `[${tag}] r${this.getRoundNumber()} myHit=${hr}% shots=${this.shotsFired} landed=${this.shotsHit} gun=${this.gun.bestGunName()} ${this.surfer.debug()} read=${this.readOpponent()}\n`;
    try {
      appendFileSync(dbg, line);
    } catch {
      /* ignore */
    }
  }
}

JbosleyBot.main();
