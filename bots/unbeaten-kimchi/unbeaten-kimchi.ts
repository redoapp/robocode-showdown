/**
 * Unbeaten Kimchi — dual-mode Tank Royale bot.
 *
 * 1v1  : wave surfing movement + GuessFactor gun (predictive-intercept fallback) + x2 radar lock.
 * Melee: minimum-risk movement + predictive gun on best target + spinning radar.
 *
 * Angle convention (verified against the API source and by experiment): 0° = east,
 * angles increase counterclockwise, so aiming is setTurnGunLeft(+calcGunBearing(angle)).
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
  BotDeathEvent,
  BulletHitBotEvent,
  RoundStartedEvent,
} from "@robocode.dev/tank-royale-bot-api";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const BINS = 47;
const MID = (BINS - 1) / 2;
const WALL_MARGIN = 18;
const STICK = 140;
const DUEL_DISTANCE = 420;

function normAbs(a: number): number {
  return ((a % 360) + 360) % 360;
}
function normRel(a: number): number {
  a = normAbs(a);
  return a >= 180 ? a - 360 : a;
}
function absAngle(x1: number, y1: number, x2: number, y2: number): number {
  return normAbs(Math.atan2(y2 - y1, x2 - x1) * R2D);
}
function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function meaDeg(bulletSpeed: number): number {
  return Math.asin(clamp(8 / bulletSpeed, 0, 1)) * R2D;
}
function gfToBin(gf: number): number {
  return Math.round(((clamp(gf, -1, 1) + 1) / 2) * (BINS - 1));
}
function kernelAdd(stats: number[], idx: number, weight: number): void {
  for (let i = 0; i < BINS; i++) stats[i] += weight * Math.exp(-((i - idx) * (i - idx)) / 8);
}

interface Snap {
  tick: number;
  x: number;
  y: number;
  energy: number;
  direction: number;
  speed: number;
}

interface Enemy {
  id: number;
  last: Snap;
  prev: Snap | null;
}

interface SurfWave {
  ox: number;
  oy: number;
  fireTick: number;
  speed: number;
  power: number;
  dirToMe: number;
  latDir: number;
}

interface GunWave {
  fx: number;
  fy: number;
  fireTick: number;
  speed: number;
  dirToEnemy: number;
  latDir: number;
  seg: number;
  targetId: number;
}

class UnbeatenKimchi extends Bot {
  private enemies = new Map<number, Enemy>();
  private surfWaves: SurfWave[] = [];
  private gunWaves: GunWave[] = [];
  // Learned stats persist across rounds (the bot instance lives for the whole game).
  private surfStats: number[] = new Array(BINS).fill(0);
  private gunStats: number[][] = [];
  private gunSegCount: number[] = new Array(15).fill(0);
  private pendingDamage = new Map<number, number>();
  private moveDir = 1;
  private meleeDest: { x: number; y: number } | null = null;
  private meleeDestTick = 0;
  private duelTargetId = -1;

  static main() {
    new UnbeatenKimchi().start();
  }

  constructor() {
    super();
    for (let s = 0; s < 15; s++) this.gunStats.push(new Array(BINS).fill(0));
    // Seed head-on danger so we dodge naive guns before any data arrives.
    kernelAdd(this.surfStats, MID, 1);
  }

  override run() {
    this.setAdjustGunForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustRadarForBodyTurn(true);

    while (this.isRunning()) {
      const duel = this.getEnemyCount() <= 1;
      this.updateWaves();
      this.doRadar(duel);
      if (duel) this.doSurfMovement();
      else this.doMinRiskMovement();
      this.doGun(duel);
      this.go();
    }
  }

  // ---------------- radar ----------------

  private doRadar(duel: boolean) {
    const turn = this.getTurnNumber();
    if (duel) {
      const e = this.duelEnemy();
      if (e && turn - e.last.tick <= 2) {
        const rb = this.radarBearingTo(e.last.x, e.last.y);
        this.setTurnRadarLeft(rb === 0 ? 22 : rb * 2);
        return;
      }
    }
    // Melee sweep / lost lock: spin at max rate (full circle every 8 turns).
    this.setTurnRadarLeft(45);
  }

  private duelEnemy(): Enemy | null {
    let best: Enemy | null = null;
    for (const e of this.enemies.values()) {
      if (!best || e.last.tick > best.last.tick) best = e;
    }
    return best;
  }

  // ---------------- waves / learning ----------------

  private updateWaves() {
    const now = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();

    this.surfWaves = this.surfWaves.filter(
      (w) => w.speed * (now - w.fireTick) < dist(w.ox, w.oy, mx, my) + 50,
    );

    const keep: GunWave[] = [];
    for (const w of this.gunWaves) {
      const t = this.enemies.get(w.targetId);
      if (!t) continue;
      const d = dist(w.fx, w.fy, t.last.x, t.last.y);
      if (w.speed * (now - w.fireTick) >= d) {
        const offset = normRel(absAngle(w.fx, w.fy, t.last.x, t.last.y) - w.dirToEnemy);
        const gf = clamp(offset / meaDeg(w.speed), -1, 1) * w.latDir;
        kernelAdd(this.gunStats[w.seg], gfToBin(gf), 1);
        this.gunSegCount[w.seg]++;
      } else if (now - w.fireTick < 120) {
        keep.push(w);
      }
    }
    this.gunWaves = keep;
  }

  // ---------------- 1v1 movement: wave surfing ----------------

  private doSurfMovement() {
    const e = this.duelEnemy();
    if (!e) {
      this.setForward(80 * this.moveDir);
      return;
    }
    const wave = this.closestWave();
    if (wave) {
      const dl = this.surfDanger(wave, -1);
      const dr = this.surfDanger(wave, 1);
      if (dl !== dr) this.moveDir = dl < dr ? -1 : 1;
    }
    this.orbit(e.last.x, e.last.y, this.moveDir, DUEL_DISTANCE);
  }

  private closestWave(): SurfWave | null {
    const now = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();
    let best: SurfWave | null = null;
    let bestEta = 1e9;
    for (const w of this.surfWaves) {
      const eta = (dist(w.ox, w.oy, mx, my) - w.speed * (now - w.fireTick)) / w.speed;
      if (eta > -2 && eta < bestEta) {
        bestEta = eta;
        best = w;
      }
    }
    return best;
  }

  /** Simulate orbiting the wave origin in the given direction until the wave catches us. */
  private surfDanger(w: SurfWave, dir: number): number {
    const now = this.getTurnNumber();
    let px = this.getX();
    let py = this.getY();
    let v = this.getSpeed();
    let h = this.getDirection();
    for (let t = 1; t < 120; t++) {
      let want = normAbs(absAngle(px, py, w.ox, w.oy) + 90 * dir);
      want = this.wallSmooth(px, py, want, dir);
      let turnAmt = normRel(want - h);
      let moveSign = 1;
      if (Math.abs(turnAmt) > 90) {
        turnAmt = normRel(turnAmt + 180);
        moveSign = -1;
      }
      const maxTurn = 10 - 0.75 * Math.abs(v);
      h = normAbs(h + clamp(turnAmt, -maxTurn, maxTurn));
      v = this.nextSpeed(v, moveSign * 8);
      px = clamp(px + v * Math.cos(h * D2R), WALL_MARGIN, this.getArenaWidth() - WALL_MARGIN);
      py = clamp(py + v * Math.sin(h * D2R), WALL_MARGIN, this.getArenaHeight() - WALL_MARGIN);
      if (w.speed * (now - w.fireTick + t) >= dist(w.ox, w.oy, px, py) - 10) break;
    }
    const offset = normRel(absAngle(w.ox, w.oy, px, py) - w.dirToMe);
    const gf = clamp(offset / meaDeg(w.speed), -1, 1) * w.latDir;
    const idx = gfToBin(gf);
    let danger = 0;
    for (let i = 0; i < BINS; i++)
      danger += this.surfStats[i] * Math.exp(-((i - idx) * (i - idx)) / 8);
    return danger;
  }

  private nextSpeed(v: number, target: number): number {
    if (target > v) return clamp(v + (v < 0 ? 2 : 1), -8, Math.min(8, target));
    if (target < v) return clamp(v - (v > 0 ? 2 : 1), Math.max(-8, target), 8);
    return v;
  }

  private orbit(cx: number, cy: number, dir: number, holdDist: number) {
    const d = this.distanceTo(cx, cy);
    // >90° offset drifts away, <90° closes in.
    const offset = 90 + clamp((holdDist - d) * 0.08, -25, 25);
    let heading = normAbs(absAngle(this.getX(), this.getY(), cx, cy) + offset * dir);
    heading = this.wallSmooth(this.getX(), this.getY(), heading, dir);
    let turnAmt = normRel(heading - this.getDirection());
    let ahead = 100;
    if (Math.abs(turnAmt) > 90) {
      turnAmt = normRel(turnAmt + 180);
      ahead = -100;
    }
    this.setMaxSpeed(8);
    this.setTurnLeft(turnAmt);
    this.setForward(ahead);
  }

  private wallSmooth(x: number, y: number, heading: number, dir: number): number {
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    for (let i = 0; i < 40; i++) {
      const tx = x + STICK * Math.cos(heading * D2R);
      const ty = y + STICK * Math.sin(heading * D2R);
      if (
        tx > WALL_MARGIN + 7 &&
        tx < w - WALL_MARGIN - 7 &&
        ty > WALL_MARGIN + 7 &&
        ty < h - WALL_MARGIN - 7
      )
        return heading;
      heading = normAbs(heading + dir * 5);
    }
    return heading;
  }

  // ---------------- melee movement: minimum risk ----------------

  private doMinRiskMovement() {
    const now = this.getTurnNumber();
    const mx = this.getX();
    const my = this.getY();
    if (
      this.meleeDest &&
      now - this.meleeDestTick < 15 &&
      dist(mx, my, this.meleeDest.x, this.meleeDest.y) > 25
    ) {
      this.driveTo(this.meleeDest.x, this.meleeDest.y);
      return;
    }
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    let best = { x: mx, y: my };
    let bestRisk = this.risk(mx, my) * 0.9; // mild bias: only move when it clearly helps
    for (let i = 0; i < 36; i++) {
      const a = Math.random() * 360;
      const r = 60 + Math.random() * 140;
      const cx = mx + r * Math.cos(a * D2R);
      const cy = my + r * Math.sin(a * D2R);
      if (cx < 43 || cx > w - 43 || cy < 43 || cy > h - 43) continue;
      const rk = this.risk(cx, cy);
      if (rk < bestRisk) {
        bestRisk = rk;
        best = { x: cx, y: cy };
      }
    }
    this.meleeDest = best;
    this.meleeDestTick = now;
    this.driveTo(best.x, best.y);
  }

  private risk(cx: number, cy: number): number {
    const myE = this.getEnergy();
    let r = 0;
    for (const e of this.enemies.values()) {
      const d2 = Math.max(1, (e.last.x - cx) ** 2 + (e.last.y - cy) ** 2);
      const energyF = (e.last.energy + 15) / (myE + 15);
      const align = Math.abs(
        Math.cos(
          (absAngle(this.getX(), this.getY(), cx, cy) - absAngle(e.last.x, e.last.y, cx, cy)) * D2R,
        ),
      );
      let closest = true;
      for (const o of this.enemies.values()) {
        if (o.id === e.id) continue;
        if (dist(o.last.x, o.last.y, e.last.x, e.last.y) < dist(cx, cy, e.last.x, e.last.y)) {
          closest = false;
          break;
        }
      }
      r += (energyF * (1 + align) * (closest ? 2 : 1)) / d2;
    }
    r *= 1e5;
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    const wx = Math.min(cx, w - cx);
    const wy = Math.min(cy, h - cy);
    r += 3000 / (Math.min(wx, wy) + 1);
    r += 300000 / ((wx + 1) * (wy + 1));
    r += Math.random() * 0.5;
    return r;
  }

  private driveTo(x: number, y: number) {
    let turnAmt = normRel(absAngle(this.getX(), this.getY(), x, y) - this.getDirection());
    let d = this.distanceTo(x, y);
    if (Math.abs(turnAmt) > 90) {
      turnAmt = normRel(turnAmt + 180);
      d = -d;
    }
    this.setMaxSpeed(Math.abs(turnAmt) > 45 ? 5 : 8);
    this.setTurnLeft(turnAmt);
    this.setForward(d);
  }

  // ---------------- gun ----------------

  private doGun(duel: boolean) {
    const target = duel ? this.duelEnemy() : this.pickMeleeTarget();
    if (!target) return;
    const now = this.getTurnNumber();
    if (now - target.last.tick > 8) return; // data too stale to aim on

    const d = this.distanceTo(target.last.x, target.last.y);
    const power = this.selectPower(duel, d, target);
    if (power <= 0) return;
    const bs = 20 - 3 * power;

    let aim: number;
    const seg = this.segIndex(d, target);
    if (duel && this.gunSegCount[seg] >= 4) {
      aim = this.gfAim(target, bs, seg);
    } else {
      aim = this.predictiveAim(target, bs);
    }
    if (d < 120) aim = this.directionTo(target.last.x, target.last.y);

    const gb = this.calcGunBearing(aim);
    this.setTurnGunLeft(gb);

    const gate = d < 120 ? 10 : 4;
    if (this.getGunHeat() === 0 && Math.abs(gb) < gate && this.getEnergy() > power) {
      if (this.setFire(power)) {
        this.gunWaves.push({
          fx: this.getX(),
          fy: this.getY(),
          fireTick: now,
          speed: bs,
          dirToEnemy: this.directionTo(target.last.x, target.last.y),
          latDir: this.latDirOf(target),
          seg,
          targetId: target.id,
        });
      }
    }
  }

  private latDirOf(e: Enemy): number {
    const bearingToMe = absAngle(e.last.x, e.last.y, this.getX(), this.getY());
    const rel = normRel(e.last.direction - bearingToMe);
    const latVel = e.last.speed * Math.sin(rel * D2R);
    return latVel >= 0 ? 1 : -1;
  }

  private segIndex(d: number, e: Enemy): number {
    const bearingToMe = absAngle(e.last.x, e.last.y, this.getX(), this.getY());
    const rel = normRel(e.last.direction - bearingToMe);
    const lat = Math.abs(e.last.speed * Math.sin(rel * D2R));
    const dSeg = Math.min(4, Math.floor(d / 180));
    const lSeg = lat < 2 ? 0 : lat < 5.5 ? 1 : 2;
    return dSeg * 3 + lSeg;
  }

  private gfAim(e: Enemy, bulletSpeed: number, seg: number): number {
    const stats = this.gunStats[seg];
    let bestBin = MID;
    let bestVal = -1;
    for (let i = 0; i < BINS; i++) {
      if (stats[i] > bestVal) {
        bestVal = stats[i];
        bestBin = i;
      }
    }
    const gf = (bestBin / (BINS - 1)) * 2 - 1;
    return normAbs(
      this.directionTo(e.last.x, e.last.y) + this.latDirOf(e) * gf * meaDeg(bulletSpeed),
    );
  }

  private predictiveAim(e: Enemy, bulletSpeed: number): number {
    const w = this.getArenaWidth();
    const h = this.getArenaHeight();
    let turnRate = 0;
    if (e.prev) {
      const dt = Math.max(1, e.last.tick - e.prev.tick);
      turnRate = normRel(e.last.direction - e.prev.direction) / dt;
    }
    let px = e.last.x;
    let py = e.last.y;
    let hd = e.last.direction;
    // Advance for staleness of the scan, then iterate to the intercept.
    const stale = this.getTurnNumber() - e.last.tick;
    for (let k = 0; k < stale; k++) {
      hd += turnRate;
      px = clamp(px + e.last.speed * Math.cos(hd * D2R), WALL_MARGIN, w - WALL_MARGIN);
      py = clamp(py + e.last.speed * Math.sin(hd * D2R), WALL_MARGIN, h - WALL_MARGIN);
    }
    for (let t = 1; t <= 80; t++) {
      hd += turnRate;
      px = clamp(px + e.last.speed * Math.cos(hd * D2R), WALL_MARGIN, w - WALL_MARGIN);
      py = clamp(py + e.last.speed * Math.sin(hd * D2R), WALL_MARGIN, h - WALL_MARGIN);
      if (bulletSpeed * t >= this.distanceTo(px, py) - 18) break;
    }
    return this.directionTo(px, py);
  }

  private pickMeleeTarget(): Enemy | null {
    const now = this.getTurnNumber();
    let closest: Enemy | null = null;
    let cd = 1e9;
    for (const e of this.enemies.values()) {
      if (now - e.last.tick > 12) continue;
      const d = this.distanceTo(e.last.x, e.last.y);
      if (d < cd) {
        cd = d;
        closest = e;
      }
    }
    if (!closest) return null;
    // Prefer a weak enemy if it is nearly as close.
    let best = closest;
    for (const e of this.enemies.values()) {
      if (now - e.last.tick > 12) continue;
      const d = this.distanceTo(e.last.x, e.last.y);
      if (e.last.energy <= 20 && d < cd * 1.3 && e.last.energy < best.last.energy) best = e;
    }
    // Sticky targeting to avoid gun thrash between equidistant enemies.
    const prev = this.duelTargetId >= 0 ? this.enemies.get(this.duelTargetId) : undefined;
    if (prev && now - prev.last.tick <= 12) {
      const dPrev = this.distanceTo(prev.last.x, prev.last.y);
      if (this.distanceTo(best.last.x, best.last.y) > dPrev * 0.8) best = prev;
    }
    this.duelTargetId = best.id;
    return best;
  }

  private selectPower(duel: boolean, d: number, target: Enemy): number {
    const myE = this.getEnergy();
    let p: number;
    if (duel) {
      p = d < 150 ? 3 : d < 350 ? 2 : d < 550 ? 1.5 : 1;
      if (myE < 20) p = Math.min(p, 1);
      if (myE < 8) p = Math.min(p, 0.5);
      if (myE < 0.4) return 0;
    } else {
      p = d < 120 ? 3 : d < 300 ? 2 : d < 470 ? 1 : 0;
      if (myE < 25) p = Math.min(p, 1);
      if (myE < 10) p = Math.min(p, 0.5);
    }
    const te = target.last.energy;
    if (te <= 4 && te > 0) p = Math.max(0.1, Math.min(p, te / 4 + 0.1));
    if (te === 0) p = 0.1;
    return p;
  }

  // ---------------- events (record-only) ----------------

  override onScannedBot(e: ScannedBotEvent) {
    const now = e.turnNumber;
    const snap: Snap = {
      tick: now,
      x: e.x,
      y: e.y,
      energy: e.energy,
      direction: e.direction,
      speed: e.speed,
    };
    let en = this.enemies.get(e.scannedBotId);
    if (!en) {
      en = { id: e.scannedBotId, last: snap, prev: null };
      this.enemies.set(e.scannedBotId, en);
      return;
    }
    const prev = en.last;
    en.prev = prev;
    en.last = snap;

    // Enemy fire detection via energy drop (masking damage we dealt them).
    const masked = this.pendingDamage.get(e.scannedBotId) ?? 0;
    this.pendingDamage.set(e.scannedBotId, 0);
    const drop = prev.energy - snap.energy - masked;
    if (drop >= 0.099 && drop <= 3.01 && now - prev.tick <= 4) {
      const power = clamp(drop, 0.1, 3);
      // My lateral direction around the shooter at fire time.
      const bearingMe = absAngle(prev.x, prev.y, this.getX(), this.getY());
      const rel = normRel(this.getDirection() - bearingMe);
      const myLat = this.getSpeed() * Math.sin(rel * D2R);
      this.surfWaves.push({
        ox: prev.x,
        oy: prev.y,
        fireTick: prev.tick,
        speed: 20 - 3 * power,
        power,
        dirToMe: bearingMe,
        latDir: myLat >= 0 ? 1 : -1,
      });
    }
  }

  override onHitByBullet(e: HitByBulletEvent) {
    // Learn: find the surf wave matching this bullet and log the hit GF.
    const b = e.bullet;
    let best: SurfWave | null = null;
    let bestErr = 51;
    for (const w of this.surfWaves) {
      if (Math.abs(w.power - b.power) > 0.11) continue;
      const r = w.speed * (e.turnNumber - w.fireTick);
      const err = Math.abs(r - dist(w.ox, w.oy, this.getX(), this.getY()));
      if (err < bestErr) {
        bestErr = err;
        best = w;
      }
    }
    if (best) {
      const offset = normRel(absAngle(best.ox, best.oy, this.getX(), this.getY()) - best.dirToMe);
      const gf = clamp(offset / meaDeg(best.speed), -1, 1) * best.latDir;
      kernelAdd(this.surfStats, gfToBin(gf), 3);
    }
    this.moveDir = -this.moveDir;
  }

  override onBulletHitBot(e: BulletHitBotEvent) {
    // Their next scan shows energy dropped by our damage — mask it from fire detection.
    const cur = this.pendingDamage.get(e.victimId) ?? 0;
    this.pendingDamage.set(e.victimId, cur + e.damage);
  }

  override onHitWall(_e: HitWallEvent) {
    this.moveDir = -this.moveDir;
    this.meleeDest = null;
  }

  override onHitBot(e: HitBotEvent) {
    this.moveDir = -this.moveDir;
    this.meleeDest = null;
    // Point-blank contact: dump max power if the gun is ready.
    if (this.getGunHeat() === 0 && this.getEnergy() > 3) {
      const gb = this.gunBearingTo(e.x, e.y);
      if (Math.abs(gb) < 20) this.setFire(3);
    }
  }

  override onBotDeath(e: BotDeathEvent) {
    this.enemies.delete(e.victimId);
    this.pendingDamage.delete(e.victimId);
    if (this.duelTargetId === e.victimId) this.duelTargetId = -1;
  }

  override onRoundStarted(_e: RoundStartedEvent) {
    // Keep learned stats; reset per-round transients.
    this.enemies.clear();
    this.surfWaves = [];
    this.gunWaves = [];
    this.pendingDamage.clear();
    this.meleeDest = null;
    this.duelTargetId = -1;
  }
}

UnbeatenKimchi.main();
