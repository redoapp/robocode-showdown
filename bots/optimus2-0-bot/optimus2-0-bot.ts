import {
    Bot,
    Color,
    ScannedBotEvent,
    HitByBulletEvent,
    BulletHitBotEvent,
    HitBotEvent,
    HitWallEvent,
    BotDeathEvent,
    DeathEvent,
} from "@robocode.dev/tank-royale-bot-api";

// ============================================================================
// Optimus2.0 — adaptive melee / duel tank for Robocode Tank Royale (v1.0.2)
//
// Angle convention: 0 deg = East, CCW-positive (standard math).
// Non-blocking turn-based control: run() loops set-intents + go() each turn.
//
// 1v1: wave-surfing movement + rolling GuessFactor gun (beats wave surfers).
// Melee: minimum-risk destination movement + iterative predictor gun (crown).
// ============================================================================

// ---- Tunable constants (tournament-day knobs) ------------------------------
const T = {
    // Radar
    RADAR_LOCK_OVERSHOOT: 12, // deg past the enemy each turn to keep a duel lock
    LOCK_LOST_TURNS: 4, // turns without a scan before we spin to reacquire

    // Firing
    POWER_CLOSE: 3.0,
    POWER_MID: 2.0,
    POWER_LONG: 1.5,
    DIST_CLOSE: 150,
    DIST_LONG: 450,
    ENERGY_LOW: 20, // below this, throttle firepower
    ENERGY_CRIT: 8, // below this, only cheap shots
    ENERGY_RESERVE: 0.2, // never fire ourselves below this
    OVERKILL_ENERGY: 16, // if target energy under this, size the shot to just kill
    AIM_TOL_MARGIN: 1.15, // multiplier on the geometric hit tolerance

    // Prediction (melee gun)
    PREDICT_MAX_STEPS: 110,
    OMEGA_MIN: 0.1, // deg/turn of target turn-rate below which we treat as linear

    // Duel wave-surf movement
    DUEL_SURF_DIST: 520, // preferred orbit distance while surfing
    SURF_FLIP_TURNS: 45, // no-data fallback: flip orbit sense this often
    GF_ROLL_N: 32, // rolling window for the GF gun (recency vs adaptive surfers)

    // Melee movement
    MELEE_SAMPLES: 21, // candidate destination directions
    MELEE_RADIUS_MIN: 120,
    MELEE_RADIUS_MAX: 210,
    MELEE_REPLAN_TURNS: 12, // re-plan destination at least this often
    MELEE_REACH_DIST: 40, // consider destination reached within this
    ENEMY_WEIGHT: 90, // added to enemy energy in the risk numerator

    // Walls / safety
    WALL_MARGIN: 70, // preferred min distance from any wall
    WALL_HARD: 40, // hard danger zone; brake / steer away aggressively

    // Enemy bookkeeping
    ENEMY_STALE_TURNS: 90, // drop map entries older than this (melee)

    // Ramming
    RAM_DIST: 90,
    RAM_ENERGY_EDGE: 1.6, // ram if our energy > enemy * this (or enemy very weak)
    RAM_ENEMY_WEAK: 16,
};

// GuessFactor / surf binning
const BINS = 31; // odd -> exact center bin = GF 0
const MID = (BINS - 1) / 2;

interface Enemy {
    id: number;
    x: number;
    y: number;
    energy: number;
    direction: number; // deg
    speed: number;
    omega: number; // deg/turn, signed
    prevDirection: number;
    turn: number; // turn last seen
}

// A bullet wave the enemy fired at us (we surf these).
interface EnemyWave {
    originX: number;
    originY: number;
    fireTime: number;
    bulletSpeed: number;
    initialTargetAngle: number; // angle origin -> our position at fire time
    maxEscape: number; // asin(8/bulletSpeed) in degrees
    direction: number; // our lateral orbit sense at fire time (+1/-1)
    segment: number; // surf-stat segment
}

// A bullet wave we fired at the enemy (we score GF hits with these).
interface GunWave {
    originX: number;
    originY: number;
    fireTime: number;
    bulletSpeed: number;
    directAngle: number; // absolute angle origin -> enemy at fire time
    maxEscape: number;
    lateralDir: number; // enemy lateral sense relative to us at fire time
    segment: number; // gun-stat segment
}

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

function normAbs(a: number): number {
    return ((a % 360) + 360) % 360;
}

function normRel(a: number): number {
    // normalize to [-180, 180)
    let x = ((a % 360) + 360) % 360;
    if (x >= 180) x -= 360;
    return x;
}

function absBearing(x1: number, y1: number, x2: number, y2: number): number {
    return normAbs(Math.atan2(y2 - y1, x2 - x1) * RAD);
}

class Optimus20Bot extends Bot {
    private enemies = new Map<number, Enemy>();
    private orbitDir = 1; // +1 CCW, -1 CW around the duel target
    private destX = -1;
    private destY = -1;
    private lastPlanTurn = -999;
    private lastLockTurn = -999;
    private lockedId = -1;

    // ---- 1v1 wave-surf + GuessFactor learning (persist across rounds) ----
    private surfStats: number[][] = []; // 3 segments x BINS
    private gunGF: number[][] = []; // 9 segments x BINS

    // per-round transient wave state
    private enemyWaves: EnemyWave[] = [];
    private gunWaves: GunWave[] = [];
    private surfDir = 1;
    private lastFlip = -999;
    private enemyDmgSinceScan = 0;

    constructor() {
        super();
        for (let s = 0; s < 3; s++) this.surfStats.push(new Array(BINS).fill(0));
        for (let s = 0; s < 9; s++) this.gunGF.push(new Array(BINS).fill(0));
    }

    static main() {
        new Optimus20Bot().start();
    }

    override run() {
        this.setBodyColor(Color.fromRgb(0x10, 0x10, 0x28));
        this.setTurretColor(Color.fromRgb(0x30, 0x60, 0xff));
        this.setRadarColor(Color.fromRgb(0x00, 0xff, 0xcc));
        this.setBulletColor(Color.fromRgb(0xff, 0xcc, 0x00));
        this.setScanColor(Color.fromRgb(0x00, 0xff, 0xcc));

        // Decouple gun & radar so movement/aim don't disturb each other.
        this.setAdjustGunForBodyTurn(true);
        this.setAdjustRadarForGunTurn(true);
        this.setAdjustRadarForBodyTurn(true);

        this.enemies.clear();
        this.destX = this.getX();
        this.destY = this.getY();
        this.lastPlanTurn = -999;
        this.orbitDir = Math.random() < 0.5 ? 1 : -1;
        this.surfDir = this.orbitDir;
        this.lastFlip = -999;
        this.enemyWaves = [];
        this.gunWaves = [];
        this.enemyDmgSinceScan = 0;

        // Start with a full radar sweep to find everyone.
        this.setRadarTurnRate(45);

        while (this.isRunning()) {
            this.pruneEnemies();
            const duel = this.getEnemyCount() <= 1;
            const t = this.getTurnNumber();

            if (duel) this.expireEnemyWaves(t);
            this.updateGunWaves(t);

            this.updateRadar(duel);
            this.updateMovement(duel);
            this.updateGun(duel);

            this.go();
        }
    }

    // ---------------------------------------------------------------- radar
    private updateRadar(duel: boolean) {
        const turn = this.getTurnNumber();
        const target = duel ? this.duelTarget() : this.gunTarget();

        if (
            target &&
            turn - this.lastLockTurn <= T.LOCK_LOST_TURNS &&
            (duel || turn - target.turn <= 2)
        ) {
            // Slip lock: sweep just past the target every turn.
            const rb = this.radarBearingTo(target.x, target.y);
            const overshoot = (rb >= 0 ? 1 : -1) * T.RADAR_LOCK_OVERSHOOT;
            this.setRadarTurnRate(rb + overshoot);
        } else {
            // Reacquire / melee: full spin.
            this.setRadarTurnRate(45);
        }
    }

    // ------------------------------------------------------------- movement
    private updateMovement(duel: boolean) {
        if (duel) this.moveDuel();
        else this.moveMelee();
    }

    // ===================== DUEL: wave surfing =====================
    private moveDuel() {
        const e = this.duelTarget();
        if (!e) {
            // No lock yet: drift forward gently while radar reacquires.
            this.setTurnRate(0);
            this.setTargetSpeed(4);
            return;
        }

        const dist = this.distanceTo(e.x, e.y);

        // Ram a weak, close enemy.
        if (this.shouldRam(e, dist)) {
            this.driveToward(e.x, e.y, 8);
            return;
        }

        this.surfMove(e);
    }

    private surfMove(e: Enemy) {
        const t = this.getTurnNumber();
        const wave = this.nearestWave(t);

        if (!wave || !this.hasData(this.surfStats[wave.segment])) {
            // No learned danger yet: perpendicular orbit + periodic flip.
            if (t - this.lastFlip > T.SURF_FLIP_TURNS) {
                this.surfDir = -this.surfDir;
                this.lastFlip = t;
            }
            this.driveTravel(this.orbitHeading(e, this.surfDir), 8);
            return;
        }

        // Evaluate danger for reverse / stop / forward orbit; pick the safest.
        let bestDir = this.surfDir;
        let bestDanger = Infinity;
        for (const dir of [-1, 0, 1]) {
            const d = this.evalDanger(wave, e, dir);
            if (d < bestDanger) {
                bestDanger = d;
                bestDir = dir;
            }
        }
        if (bestDir === 0) {
            this.driveTravel(this.orbitHeading(e, this.surfDir), 0);
        } else {
            this.surfDir = bestDir;
            this.driveTravel(this.orbitHeading(e, bestDir), 8);
        }
    }

    // Project our motion under `orbitDir` until `wave` intercepts us, then
    // score the landing GuessFactor bin against learned danger.
    private evalDanger(wave: EnemyWave, e: Enemy, orbitDir: number): number {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        let px = this.getX();
        let py = this.getY();
        let head = this.getDirection();
        let vel = this.getSpeed();
        let t = this.getTurnNumber();

        for (let step = 0; step < 160; step++) {
            if (orbitDir === 0) {
                vel += clamp(0 - vel, -2, 1);
            } else {
                const travel = this.orbitHeadingAround(
                    px,
                    py,
                    e.x,
                    e.y,
                    orbitDir,
                );
                const bearing = normRel(travel - head);
                const forward = Math.abs(bearing) <= 90;
                const bodyGoal = forward ? travel : normAbs(travel + 180);
                const maxT = this.maxTurnAt(vel);
                const turn = clamp(normRel(bodyGoal - head), -maxT, maxT);
                head = normAbs(head + turn);
                vel += clamp((forward ? 8 : -8) - vel, -2, 1);
            }
            px += Math.cos(head * DEG) * vel;
            py += Math.sin(head * DEG) * vel;
            px = clamp(px, 18, w - 18);
            py = clamp(py, 18, h - 18);
            t++;
            if (
                this.dist2(wave.originX, wave.originY, px, py) <=
                Math.pow(wave.bulletSpeed * (t - wave.fireTime), 2)
            ) {
                break;
            }
        }

        const bin = this.binFor(wave, px, py);
        let danger = this.smoothedStat(this.surfStats[wave.segment], bin);
        // Slight preference for keeping distance.
        const endDist = Math.hypot(px - e.x, py - e.y);
        if (endDist < 450) danger += (450 - endDist) * 0.002;
        return danger;
    }

    private dist2(x1: number, y1: number, x2: number, y2: number): number {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return dx * dx + dy * dy;
    }

    private binFor(wave: EnemyWave, px: number, py: number): number {
        const ang = absBearing(wave.originX, wave.originY, px, py);
        const offset = normRel(ang - wave.initialTargetAngle);
        const factor = clamp((offset / wave.maxEscape) * wave.direction, -1, 1);
        return Math.round(((factor + 1) / 2) * (BINS - 1));
    }

    private smoothedStat(buf: number[], bin: number): number {
        let d = 0;
        for (let i = 0; i < BINS; i++) {
            const x = i - bin;
            d += buf[i] / (x * x + 1);
        }
        return d;
    }

    private hasData(buf: number[]): boolean {
        for (let i = 0; i < BINS; i++) if (buf[i] > 0) return true;
        return false;
    }

    private nearestWave(t: number): EnemyWave | null {
        const mx = this.getX();
        const my = this.getY();
        let best: EnemyWave | null = null;
        let bestTime = Infinity;
        for (const wv of this.enemyWaves) {
            const front = wv.bulletSpeed * (t - wv.fireTime);
            const d = Math.hypot(wv.originX - mx, wv.originY - my);
            const timeToHit = (d - front) / wv.bulletSpeed;
            if (timeToHit > -1 && timeToHit < bestTime) {
                bestTime = timeToHit;
                best = wv;
            }
        }
        return best;
    }

    private expireEnemyWaves(t: number) {
        const mx = this.getX();
        const my = this.getY();
        for (let i = this.enemyWaves.length - 1; i >= 0; i--) {
            const wv = this.enemyWaves[i];
            const front = wv.bulletSpeed * (t - wv.fireTime);
            const d = Math.hypot(wv.originX - mx, wv.originY - my);
            // Bullet has passed well beyond us: drop it.
            if (front > d + 40) this.enemyWaves.splice(i, 1);
        }
    }

    private orbitHeading(e: Enemy, orbitDir: number): number {
        return this.orbitHeadingAround(
            this.getX(),
            this.getY(),
            e.x,
            e.y,
            orbitDir,
        );
    }

    private orbitHeadingAround(
        px: number,
        py: number,
        ex: number,
        ey: number,
        orbitDir: number,
    ): number {
        const eb = absBearing(ex, ey, px, py); // enemy -> me (outward)
        const d = Math.hypot(ex - px, ey - py);
        let offset = 90;
        const distErr = (T.DUEL_SURF_DIST - d) / T.DUEL_SURF_DIST; // >0 too close
        offset -= distErr * 25; // too close -> smaller offset -> outward component
        offset = clamp(offset, 55, 125);
        const desired = normAbs(eb + orbitDir * offset);
        return this.surfWallSmooth(px, py, desired, orbitDir === 0 ? 1 : orbitDir);
    }

    // Rotate desired travel heading until the look-ahead point is inside arena.
    private surfWallSmooth(
        px: number,
        py: number,
        desired: number,
        rotDir: number,
    ): number {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        const stick = 150;
        const margin = 40;
        for (let i = 0; i < 30; i++) {
            const r = desired * DEG;
            const ax = px + Math.cos(r) * stick;
            const ay = py + Math.sin(r) * stick;
            if (
                ax > margin &&
                ax < w - margin &&
                ay > margin &&
                ay < h - margin
            ) {
                return desired;
            }
            desired = normAbs(desired + rotDir * 12);
        }
        return absBearing(px, py, w / 2, h / 2);
    }

    private maxTurnAt(speed: number): number {
        return 10 - 0.75 * Math.min(Math.abs(speed), 8);
    }

    // Drive so the bot physically travels along `travel` (reverse if closer).
    private driveTravel(travel: number, maxSpeed: number) {
        const bearing = normRel(travel - this.getDirection());
        if (Math.abs(bearing) <= 90) {
            this.setTurnRate(clamp(bearing, -10, 10));
            this.setTargetSpeed(maxSpeed);
        } else {
            this.setTurnRate(clamp(normRel(bearing - 180), -10, 10));
            this.setTargetSpeed(-maxSpeed);
        }
    }

    // ===================== MELEE: minimum-risk movement =====================
    private moveMelee() {
        const turn = this.getTurnNumber();
        const living = this.livingEnemies();

        // Ram check first: weak enemy right next to us.
        const closest = this.closestEnemy();
        if (closest) {
            const d = this.distanceTo(closest.x, closest.y);
            if (this.shouldRam(closest, d)) {
                this.driveToward(closest.x, closest.y, 8);
                return;
            }
        }

        const reached =
            this.distanceTo(this.destX, this.destY) < T.MELEE_REACH_DIST;
        if (reached || turn - this.lastPlanTurn >= T.MELEE_REPLAN_TURNS) {
            this.planMeleeDestination(living);
            this.lastPlanTurn = turn;
        }

        this.driveToward(this.destX, this.destY, 8);
    }

    private planMeleeDestination(living: Enemy[]) {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        const px = this.getX();
        const py = this.getY();
        const cx = w / 2;
        const cy = h / 2;

        let best = { x: this.destX, y: this.destY };
        let bestRisk = Infinity;

        const baseAngle = Math.random() * 360;
        for (let i = 0; i < T.MELEE_SAMPLES; i++) {
            const ang = (baseAngle + (i * 360) / T.MELEE_SAMPLES) * DEG;
            const radius =
                T.MELEE_RADIUS_MIN +
                Math.random() * (T.MELEE_RADIUS_MAX - T.MELEE_RADIUS_MIN);
            let x = px + Math.cos(ang) * radius;
            let y = py + Math.sin(ang) * radius;
            x = clamp(x, T.WALL_HARD, w - T.WALL_HARD);
            y = clamp(y, T.WALL_HARD, h - T.WALL_HARD);

            const risk = this.riskAt(x, y, living, cx, cy, px, py);
            if (risk < bestRisk) {
                bestRisk = risk;
                best = { x, y };
            }
        }
        this.destX = best.x;
        this.destY = best.y;
    }

    private riskAt(
        x: number,
        y: number,
        living: Enemy[],
        cx: number,
        cy: number,
        px: number,
        py: number,
    ): number {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        let risk = 0;

        for (const e of living) {
            const dx = x - e.x;
            const dy = y - e.y;
            const d2 = Math.max(dx * dx + dy * dy, 1);
            // Closer & stronger enemies are more dangerous.
            let contrib = (e.energy + T.ENEMY_WEIGHT) / d2;
            // Bonus for moving perpendicular to this enemy (harder to hit).
            const toEnemy = Math.atan2(e.y - py, e.x - px);
            const toPoint = Math.atan2(y - py, x - px);
            const rel = Math.abs(normRel((toPoint - toEnemy) / DEG));
            const perp = Math.abs(Math.abs(rel) - 90) / 90; // 0 perp, 1 head-on/away
            contrib *= 1 + perp * 0.6;
            risk += contrib;
        }

        // Wall proximity: keep a comfortable margin, dread corners.
        const dl = x;
        const dr = w - x;
        const db = y;
        const dt = h - y;
        for (const dw of [dl, dr, db, dt]) {
            if (dw < T.WALL_MARGIN) {
                const tt = (T.WALL_MARGIN - dw) / T.WALL_MARGIN;
                risk += tt * tt * 4;
            }
        }

        // Mild dislike of the arena center (crossfire) when crowded.
        if (living.length >= 3) {
            const dc2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
            risk += (12000 / (dc2 + 1e4)) * 0.15;
        }

        // Small penalty for barely moving (encourage commitment).
        const moveD2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (moveD2 < T.MELEE_RADIUS_MIN * T.MELEE_RADIUS_MIN * 0.25) risk += 0.3;

        return risk;
    }

    // Drive toward an absolute point, reversing if it's behind us.
    private driveToward(tx: number, ty: number, maxSpeed: number) {
        let bearing = this.bearingTo(tx, ty);
        let dir = 1;
        if (Math.abs(bearing) > 90) {
            bearing = normRel(bearing + 180);
            dir = -1;
        }
        let speed = maxSpeed;
        if (Math.abs(bearing) > 45) speed = maxSpeed * 0.5;
        this.setTurnRate(clamp(bearing, -10, 10));
        this.setTargetSpeed(this.wallBrake(dir * speed));
    }

    // Reduce speed if we're about to drive into a wall at range.
    private wallBrake(speed: number): number {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        const x = this.getX();
        const y = this.getY();
        const heading = this.getDirection() * DEG;
        const look = Math.max(Math.abs(speed) * 3, 24) * Math.sign(speed || 1);
        const nx = x + Math.cos(heading) * look;
        const ny = y + Math.sin(heading) * look;
        if (
            nx < T.WALL_HARD ||
            nx > w - T.WALL_HARD ||
            ny < T.WALL_HARD ||
            ny > h - T.WALL_HARD
        ) {
            return Math.sign(speed) * Math.min(Math.abs(speed), 3);
        }
        return speed;
    }

    private shouldRam(e: Enemy, dist: number): boolean {
        if (dist > T.RAM_DIST) return false;
        const myE = this.getEnergy();
        return e.energy < T.RAM_ENEMY_WEAK || myE > e.energy * T.RAM_ENERGY_EDGE;
    }

    // ------------------------------------------------------------------ gun
    private updateGun(duel: boolean) {
        const target = duel ? this.duelTarget() : this.gunTarget();
        if (!target) {
            this.setGunTurnRate(0);
            return;
        }

        const dist = this.distanceTo(target.x, target.y);
        const firepower = this.selectPower(dist, target.energy);
        const bulletSpeed = 20 - 3 * firepower;

        // Aim: GuessFactor in duels (learns dodgers), predictor in melee.
        let aimAbs: number;
        if (duel) {
            aimAbs = this.aimGuessFactor(target, dist, bulletSpeed, firepower);
        } else {
            const p = this.predict(target, bulletSpeed);
            aimAbs = this.directionTo(p.x, p.y);
        }

        const gunBearing = normRel(aimAbs - this.getGunDirection());
        this.setGunTurnRate(clamp(gunBearing, -20, 20));

        // Geometric tolerance: half-angle subtended by the 18u target radius.
        const tol =
            (Math.atan2(18, Math.max(dist, 1)) / DEG) * T.AIM_TOL_MARGIN + 0.5;

        if (
            this.getGunHeat() === 0 &&
            Math.abs(gunBearing) <= tol &&
            this.getEnergy() > firepower + T.ENERGY_RESERVE
        ) {
            if (this.setFire(firepower) && duel) {
                this.recordGunWave(target, dist, bulletSpeed);
            }
        }
    }

    // GuessFactor aim: aim at the enemy's densest historical escape bin.
    private aimGuessFactor(
        e: Enemy,
        dist: number,
        bulletSpeed: number,
        _firepower: number,
    ): number {
        const direct = this.directionTo(e.x, e.y);
        const maxEscape = Math.asin(8 / bulletSpeed) * RAD;
        const latVel = e.speed * Math.sin((e.direction - direct) * DEG);
        const lateralDir = latVel >= 0 ? 1 : -1;
        const seg = this.gunSeg(dist, Math.abs(latVel));

        if (this.hasData(this.gunGF[seg])) {
            const bin = this.bestBin(this.gunGF[seg]);
            const factor = (bin / (BINS - 1)) * 2 - 1;
            return normAbs(direct + factor * maxEscape * lateralDir);
        }
        // No learned data: fall back to the iterative predictor.
        const p = this.predict(e, bulletSpeed);
        return this.directionTo(p.x, p.y);
    }

    private recordGunWave(e: Enemy, dist: number, bulletSpeed: number) {
        const direct = this.directionTo(e.x, e.y);
        const maxEscape = Math.asin(8 / bulletSpeed) * RAD;
        const latVel = e.speed * Math.sin((e.direction - direct) * DEG);
        const lateralDir = latVel >= 0 ? 1 : -1;
        const seg = this.gunSeg(dist, Math.abs(latVel));
        this.gunWaves.push({
            originX: this.getX(),
            originY: this.getY(),
            fireTime: this.getTurnNumber(),
            bulletSpeed,
            directAngle: direct,
            maxEscape,
            lateralDir,
            segment: seg,
        });
    }

    // Record gun waves that have reached the enemy into the rolling GF stats.
    private updateGunWaves(t: number) {
        if (this.gunWaves.length === 0) return;
        const e = this.duelTarget();
        if (!e) return;
        for (let i = this.gunWaves.length - 1; i >= 0; i--) {
            const wv = this.gunWaves[i];
            const traveled = wv.bulletSpeed * (t - wv.fireTime);
            const d = Math.hypot(wv.originX - e.x, wv.originY - e.y);
            if (traveled >= d) {
                const ang = absBearing(wv.originX, wv.originY, e.x, e.y);
                const offset = normRel(ang - wv.directAngle);
                const factor = clamp(
                    (offset / wv.maxEscape) * wv.lateralDir,
                    -1,
                    1,
                );
                const bin = Math.round(((factor + 1) / 2) * (BINS - 1));
                const buf = this.gunGF[wv.segment];
                // Rolling update: recent enemy behavior dominates (anti-surfer).
                const decay = 1 - 1 / T.GF_ROLL_N;
                for (let b = 0; b < BINS; b++) buf[b] *= decay;
                buf[bin] += 1;
                this.gunWaves.splice(i, 1);
            }
        }
    }

    private bestBin(buf: number[]): number {
        let best = MID;
        let bestVal = -1;
        for (let i = 0; i < BINS; i++) {
            const s = this.smoothedStat(buf, i);
            if (s > bestVal) {
                bestVal = s;
                best = i;
            }
        }
        return best;
    }

    private gunSeg(d: number, absLatVel: number): number {
        const db = d < 250 ? 0 : d < 600 ? 1 : 2;
        const lb = absLatVel < 1 ? 0 : absLatVel < 5 ? 1 : 2;
        return db * 3 + lb;
    }

    private selectPower(dist: number, targetEnergy: number): number {
        let p: number;
        if (dist < T.DIST_CLOSE) p = T.POWER_CLOSE;
        else if (dist > T.DIST_LONG) p = T.POWER_LONG;
        else {
            const t = (dist - T.DIST_CLOSE) / (T.DIST_LONG - T.DIST_CLOSE);
            p = T.POWER_MID + (1 - t) * (T.POWER_CLOSE - T.POWER_MID) * 0.5;
        }

        const myE = this.getEnergy();
        if (myE < T.ENERGY_LOW) p = Math.min(p, 1 + (myE / T.ENERGY_LOW) * 1.5);
        if (myE < T.ENERGY_CRIT) p = Math.min(p, 0.6);

        // Don't overkill a nearly-dead target.
        if (targetEnergy < T.OVERKILL_ENERGY) {
            p = Math.min(p, Math.max(targetEnergy / 4 + 0.1, 0.1));
        }

        p = Math.min(p, myE - T.ENERGY_RESERVE);
        return clamp(p, 0.1, 3.0);
    }

    // Iterative prediction (melee gun): advance the target (circular if it's
    // turning, else linear) until a bullet fired now would reach it.
    private predict(e: Enemy, bulletSpeed: number): { x: number; y: number } {
        const w = this.getArenaWidth();
        const h = this.getArenaHeight();
        const px = this.getX();
        const py = this.getY();

        if (Math.abs(e.speed) < 0.3) return { x: e.x, y: e.y };

        const useCircular = Math.abs(e.omega) > T.OMEGA_MIN;
        let heading = e.direction * DEG;
        const omega = (useCircular ? e.omega : 0) * DEG;
        let tx = e.x;
        let ty = e.y;

        for (let step = 1; step <= T.PREDICT_MAX_STEPS; step++) {
            heading += omega;
            tx += Math.cos(heading) * e.speed;
            ty += Math.sin(heading) * e.speed;
            tx = clamp(tx, 18, w - 18);
            ty = clamp(ty, 18, h - 18);

            const dx = tx - px;
            const dy = ty - py;
            const bulletDist = bulletSpeed * step;
            if (Math.sqrt(dx * dx + dy * dy) <= bulletDist) break;
        }
        return { x: tx, y: ty };
    }

    // ------------------------------------------------------- target picking
    private duelTarget(): Enemy | undefined {
        let best: Enemy | undefined;
        for (const e of this.enemies.values()) {
            if (!best || e.turn > best.turn) best = e;
        }
        return best;
    }

    private gunTarget(): Enemy | undefined {
        const turn = this.getTurnNumber();
        let best: Enemy | undefined;
        let bestScore = Infinity;
        for (const e of this.enemies.values()) {
            const dist = this.distanceTo(e.x, e.y);
            const age = turn - e.turn;
            const score =
                dist +
                e.energy * 1.5 +
                age * 8 -
                (100 - Math.min(e.energy, 100)) * 0.5;
            if (score < bestScore) {
                bestScore = score;
                best = e;
            }
        }
        return best;
    }

    private closestEnemy(): Enemy | undefined {
        let best: Enemy | undefined;
        let bestD = Infinity;
        for (const e of this.enemies.values()) {
            const d = this.distanceTo(e.x, e.y);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    private livingEnemies(): Enemy[] {
        return Array.from(this.enemies.values());
    }

    private pruneEnemies() {
        const turn = this.getTurnNumber();
        for (const [id, e] of this.enemies) {
            if (turn - e.turn > T.ENEMY_STALE_TURNS) this.enemies.delete(id);
        }
    }

    private surfSeg(absLatVel: number): number {
        return absLatVel < 2 ? 0 : absLatVel < 6 ? 1 : 2;
    }

    // --------------------------------------------------------------- events
    override onScannedBot(e: ScannedBotEvent) {
        const prev = this.enemies.get(e.scannedBotId);
        const turn = this.getTurnNumber();
        const duel = this.getEnemyCount() <= 1;

        let omega = 0;
        if (prev) {
            const dt = turn - prev.turn;
            if (dt > 0 && dt <= 8) {
                omega = normRel(e.direction - prev.direction) / dt;
            }

            // Enemy fired at us: create a surf wave (duel only).
            if (duel) {
                const drop = prev.energy - e.energy - this.enemyDmgSinceScan;
                if (drop >= 0.09 && drop <= 3.05) {
                    const power = clamp(drop, 0.1, 3);
                    const bs = 20 - 3 * power;
                    const mx = this.getX();
                    const my = this.getY();
                    const eb = absBearing(e.x, e.y, mx, my); // origin -> us
                    const mySpeed = this.getSpeed();
                    const myDir = this.getDirection();
                    const ourLat = mySpeed * Math.sin((myDir - eb) * DEG);
                    this.enemyWaves.push({
                        originX: e.x,
                        originY: e.y,
                        fireTime: turn - 1,
                        bulletSpeed: bs,
                        initialTargetAngle: eb,
                        maxEscape: Math.asin(8 / bs) * RAD,
                        direction: ourLat >= 0 ? 1 : -1,
                        segment: this.surfSeg(Math.abs(ourLat)),
                    });
                }
            }
        }
        this.enemyDmgSinceScan = 0;

        this.enemies.set(e.scannedBotId, {
            id: e.scannedBotId,
            x: e.x,
            y: e.y,
            energy: e.energy,
            direction: e.direction,
            speed: e.speed,
            omega,
            prevDirection: prev ? prev.direction : e.direction,
            turn,
        });

        this.lastLockTurn = turn;
        this.lockedId = e.scannedBotId;
    }

    override onHitByBullet(e: HitByBulletEvent) {
        const t = this.getTurnNumber();
        const mx = this.getX();
        const my = this.getY();
        const bulletSpeed = e.bullet.speed;

        // Match the enemy wave that best fits this bullet, record surf danger.
        let bestIdx = -1;
        let bestErr = Infinity;
        for (let i = 0; i < this.enemyWaves.length; i++) {
            const wv = this.enemyWaves[i];
            if (Math.abs(wv.bulletSpeed - bulletSpeed) > 0.6) continue;
            const traveled = wv.bulletSpeed * (t - wv.fireTime);
            const err = Math.abs(
                traveled - Math.hypot(wv.originX - mx, wv.originY - my),
            );
            if (err < bestErr) {
                bestErr = err;
                bestIdx = i;
            }
        }
        if (bestIdx >= 0) {
            const wv = this.enemyWaves[bestIdx];
            const bin = this.binFor(wv, mx, my);
            this.surfStats[wv.segment][bin] += 1;
            this.enemyWaves.splice(bestIdx, 1);
        }
        this.lastFlip = t; // straighten out reflexively
    }

    override onBulletHitBot(e: BulletHitBotEvent) {
        // Our bullet hit the enemy: account for it so a subsequent energy drop
        // isn't misread as the enemy firing (duel surf-wave detection).
        this.enemyDmgSinceScan += e.damage;
    }

    override onHitBot(e: HitBotEvent) {
        const existing = this.enemies.get(e.victimId);
        if (existing) {
            existing.x = e.x;
            existing.y = e.y;
            existing.energy = e.energy;
            existing.turn = this.getTurnNumber();
        }
        if (e.isRammed) this.surfDir = -this.surfDir;
    }

    override onHitWall(_e: HitWallEvent) {
        // Force a re-plan and back off the wall (melee); peel off (duel).
        this.lastPlanTurn = -999;
        this.destX = this.getArenaWidth() / 2;
        this.destY = this.getArenaHeight() / 2;
        this.surfDir = -this.surfDir;
    }

    override onBotDeath(e: BotDeathEvent) {
        this.enemies.delete(e.victimId);
    }

    override onDeath(_e: DeathEvent) {
        // nothing to clean up
    }
}

Optimus20Bot.main();
