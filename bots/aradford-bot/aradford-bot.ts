/**
 * aradford-bot — a survivalist in melee, a duelist in a 1v1.
 *
 * The insight this bot is built on: melee and 1v1 reward opposite behaviour.
 * In a 4-bot fight, the bot that drives into the middle and orbits a target is
 * the bot three enemies are shooting at. Sitting out the early scrum and
 * arriving at the endgame with full energy beats winning any single exchange.
 *
 * So the bot has two modes, switched on getEnemyCount():
 *
 *   MELEE (2+ enemies alive) — anti-gravity movement. Every enemy and every
 *     wall pushes us away; we drive down the combined gradient into open space.
 *     We hold fire unless something gets close enough to be a threat, keeping
 *     our energy and staying off everyone's radar while they wear each other down.
 *
 *   DUEL (1 enemy left) — the classic: lock the radar, lead the target, orbit
 *     it, and reverse when hit. This runs in the endgame of a melee round too,
 *     which is where melee rounds are actually won.
 *
 * See docs/API_CHEATSHEET.md for the API.
 * Melee test: npm run battle -- aradford-bot Hunter SampleBot joshmoody-bot --rounds 100
 */
import {
  Bot,
  ScannedBotEvent,
  HitByBulletEvent,
  HitWallEvent,
  HitBotEvent,
  BotDeathEvent,
} from "@robocode.dev/tank-royale-bot-api";

/** Fire only when the gun is within this many degrees of the target. */
const AIM_TOLERANCE = 10;
/** Duel mode: how far we try to stay from the enemy. */
const PREFERRED_RANGE = 250;

/** Melee: only shoot when something is this close — it's already a threat. */
const SELF_DEFENSE_RANGE = 150;
/** Minimum-risk movement: how many candidate destinations we score each re-plan. */
const CANDIDATE_RINGS = 3;
const CANDIDATE_ANGLES = 16;
/** Risk weight for proximity to an enemy, scaled by that enemy's energy. */
const ENEMY_RISK = 100_000;
/** Risk weight for sitting on an enemy's existing firing line. */
const HEAD_ON_RISK = 8;
/**
 * Melee: walls push inward once we're within WALL_MARGIN of them, ramping to
 * full strength at the wall itself. An inverse-square wall force is too weak
 * until you're already touching it — by then three enemies can pin you there,
 * which is exactly how this bot kept dying.
 */
const WALL_MARGIN = 150;
const WALL_STRENGTH = 40;
/** Melee: how far along the force vector we place each destination. */
const LOOKAHEAD = 150;
/** Re-plan once we're this close to the destination. */
const ARRIVAL_RADIUS = 30;
/** Re-plan at least this often, so a stale destination can't strand us. */
const REPLAN_TURNS = 20;
/** Stuck detection: if we move less than this far in this many turns, re-plan. */
const STUCK_CHECK_TURNS = 12;
const STUCK_DISTANCE = 15;
/** Forget an enemy's position if we haven't scanned it in this many turns. */
const STALE_AFTER_TURNS = 30;
/** Melee radar: overshoot the stalest enemy so the radar sweeps across it. */
const RADAR_OVERSHOOT = 1.6;
/**
 * Target selection: how many pixels of extra distance one point of enemy energy
 * is worth. At 4, a bot with 20 energy is as attractive as one 320px closer.
 */
const ENERGY_WEIGHT = 4;
/** Effective distance discount for the bot that last shot us. */
const RETALIATION_BONUS = 150;

interface EnemyState {
  id: number;
  x: number;
  y: number;
  direction: number;
  speed: number;
  energy: number;
  lastSeenTurn: number;
}

class AradfordBot extends Bot {
  /** 1 = orbit one way, -1 = the other. Flipped whenever we're hit. */
  private orbitDirection = 1;
  /** Last known position of every living enemy, keyed by bot id. */
  private readonly enemies = new Map<number, EnemyState>();
  /** Turn we last got a scan, so duel mode can notice it lost the lock. */
  private lastScanTurn = 0;
  /** Who last put a bullet in us — they get priority as a target. */
  private lastAttackerId: number | null = null;
  /** 1 = driving forward, -1 = reversing. Chosen when a destination is set. */
  private driveSign = 1;
  /** Committed destination in arena coordinates, or null to plan a new one. */
  private destination: { x: number; y: number } | null = null;
  private destinationSetTurn = 0;
  /** Where we were when we last checked for progress — see isStuck(). */
  private lastProgressTurn = 0;
  private lastProgressX = 0;
  private lastProgressY = 0;

  static main() {
    new AradfordBot().start();
  }

  override run() {
    // Decouple the three parts: a body turn shouldn't drag the gun and radar
    // off target. Without these, the radar lock fights our own movement.
    this.setAdjustRadarForBodyTurn(true);
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);

    // Each round is a fresh battle — last round's ghosts would poison the
    // anti-gravity field.
    this.enemies.clear();
    this.destination = null;
    this.lastAttackerId = null;

    // Drive one decision per turn. go() commits this turn's queued commands and
    // blocks until the next one, so all the set*() calls below apply together.
    while (this.isRunning()) {
      if (this.isMelee()) {
        this.meleeTurn();
      } else {
        this.duelTurn();
      }
      this.go();
    }
  }

  private isMelee(): boolean {
    return this.getEnemyCount() > 1;
  }

  // --- MELEE MODE ---------------------------------------------------------

  /**
   * Survive. Keep the radar spinning so the anti-gravity field stays fresh,
   * drive away from everything, and only shoot in self-defense.
   */
  private meleeTurn() {
    this.sweepOldestScanned();
    this.driveToDestination();
    this.engageNearest();
  }

  /**
   * The melee radar problem: three enemies never fit in one 45-degree scan arc,
   * so a freely spinning radar leaves someone unseen for long stretches. A bot
   * we've forgotten contributes NO repulsion to the force field, so we'll
   * happily drive straight into it.
   *
   * The standard answer is "oldest scanned": point the radar at whichever enemy
   * we haven't seen for the longest. Until we've found everyone, just spin.
   */
  private sweepOldestScanned() {
    if (this.enemies.size < this.getEnemyCount()) {
      this.setTurnRadarRight(360); // haven't met everyone yet — keep looking
      return;
    }

    let stalest: EnemyState | null = null;
    for (const enemy of this.enemies.values()) {
      if (!stalest || enemy.lastSeenTurn < stalest.lastSeenTurn) stalest = enemy;
    }
    if (!stalest) {
      this.setTurnRadarRight(360);
      return;
    }

    // Overshoot slightly so the sweep carries the radar across the target
    // rather than stopping exactly on it (a stopped radar scans nothing).
    const radarBearing = this.radarBearingTo(stalest.x, stalest.y);
    this.setTurnRadarLeft(radarBearing * RADAR_OVERSHOOT);
  }

  /**
   * Drive to a committed destination in ARENA coordinates.
   *
   * The destination must not be recomputed relative to our own position each
   * turn: that makes it slide away as we move, so the bearing never converges,
   * the tank turns forever and never builds speed. Instead we pick a point,
   * commit to it (and to driving forwards or backwards into it), and only
   * re-plan on arrival, on a timer, or when something knocks us off course.
   */
  private driveToDestination() {
    const needsPlan =
      this.destination === null ||
      this.distanceTo(this.destination.x, this.destination.y) < ARRIVAL_RADIUS ||
      this.getTurnNumber() - this.destinationSetTurn > REPLAN_TURNS ||
      this.isStuck();

    if (needsPlan) this.planDestination();
    const destination = this.destination;
    if (!destination) return;

    // A POSITIVE bearing means the target is to our LEFT: arena angles increase
    // counter-clockwise. Turning right by a positive bearing steers away from
    // the destination — verified in-game, and the mistake the cheatsheet's
    // examples make.
    const bearing = this.bearingTo(destination.x, destination.y);
    if (this.driveSign === 1) {
      this.setTurnLeft(bearing);
      this.setForward(this.distanceTo(destination.x, destination.y));
    } else {
      // Point the *back* of the tank at the destination and reverse into it.
      this.setTurnLeft(bearing > 0 ? bearing - 180 : bearing + 180);
      this.setBack(this.distanceTo(destination.x, destination.y));
    }
  }

  /**
   * Wedged against a wall or another tank: the throttle is open but we aren't
   * going anywhere. Watch actual displacement rather than getSpeed(), which
   * still reads non-zero while we grind against something.
   */
  private isStuck(): boolean {
    const now = this.getTurnNumber();
    if (now - this.lastProgressTurn < STUCK_CHECK_TURNS) return false;

    const moved = Math.hypot(this.getX() - this.lastProgressX, this.getY() - this.lastProgressY);
    this.lastProgressTurn = now;
    this.lastProgressX = this.getX();
    this.lastProgressY = this.getY();
    return moved < STUCK_DISTANCE;
  }

  /**
   * Minimum Risk Movement: sample candidate destinations around us, score each
   * with riskAt(), and drive to the safest.
   *
   * This replaces summing repulsion forces. A force sum can cancel out at a
   * "happy point" where the bot sits still in the middle of danger, and it can
   * only ever push us straight down the gradient. Scoring discrete points lets
   * us compare genuinely different options — including driving *past* an enemy
   * to reach open space behind it, which a force sum will never choose.
   */
  private planDestination() {
    const margin = WALL_MARGIN / 2;
    let bestX = this.getX();
    let bestY = this.getY();
    let bestRisk = Infinity;

    for (let ring = 0; ring < CANDIDATE_RINGS; ring++) {
      const radius = LOOKAHEAD * (ring + 1);
      for (let i = 0; i < CANDIDATE_ANGLES; i++) {
        // Offset each ring so candidates don't line up spoke-like, and jitter
        // so two bots in identical positions don't make identical choices.
        const angle = ((i + ring * 0.5 + Math.random() * 0.5) / CANDIDATE_ANGLES) * 2 * Math.PI;
        const x = this.getX() + Math.cos(angle) * radius;
        const y = this.getY() + Math.sin(angle) * radius;
        if (x < margin || y < margin || x > this.getArenaWidth() - margin || y > this.getArenaHeight() - margin) {
          continue; // never plan a route into a wall
        }
        const risk = this.riskAt(x, y);
        if (risk < bestRisk) {
          bestRisk = risk;
          bestX = x;
          bestY = y;
        }
      }
    }

    this.destination = { x: bestX, y: bestY };
    this.destinationSetTurn = this.getTurnNumber();
    this.driveSign = Math.abs(this.bearingTo(bestX, bestY)) <= 90 ? 1 : -1;
  }

  /**
   * How dangerous is standing at (x, y)? Lower is better.
   *
   * Enemy term: a strong bot nearby is worse than a weak one, and risk falls
   * off with the square of distance. Using energy — not just position — means
   * we crowd wounded bots and give healthy ones room.
   *
   * Head-on term: sitting on the line between us and an enemy makes their aim
   * trivial. We penalise candidate points that keep our bearing to an enemy
   * roughly unchanged, which biases us into lateral (orbiting) motion.
   *
   * Wall term: corners kill. Penalise proximity to the edges.
   */
  private riskAt(x: number, y: number): number {
    let risk = 0;

    for (const enemy of this.livingEnemies()) {
      const distanceSq = Math.max((x - enemy.x) ** 2 + (y - enemy.y) ** 2, 1);
      risk += (ENEMY_RISK * Math.max(enemy.energy, 1)) / distanceSq;

      // cos of the angle between "enemy -> candidate" and "enemy -> us".
      // 1 means the candidate is directly on their firing line to us.
      const toUs = Math.atan2(this.getY() - enemy.y, this.getX() - enemy.x);
      const toCandidate = Math.atan2(y - enemy.y, x - enemy.x);
      risk += HEAD_ON_RISK * Math.abs(Math.cos(toUs - toCandidate));
    }

    // Walls: cheap linear penalty as we approach each edge.
    risk += wallPush(x) + wallPush(this.getArenaWidth() - x);
    risk += wallPush(y) + wallPush(this.getArenaHeight() - y);

    return risk;
  }

  /**
   * Shoot the nearest enemy whenever the gun happens to line up. We never chase
   * — movement is still owned entirely by the force field — but a bullet that
   * hits refunds 3x its power, so a bot that holds fire can only bleed energy.
   */
  private engageNearest() {
    const target = this.pickTarget();
    if (!target) return;

    const distance = this.distanceTo(target.x, target.y);
    // Light shots in a crowd: cheap, fast, and they keep the energy flowing.
    const firepower = distance < SELF_DEFENSE_RANGE ? 2 : 1;
    const [aimX, aimY] = this.predictPosition(target, distance, firepower);

    // Positive bearing = left. See the note in driveToDestination().
    const gunBearing = this.gunBearingTo(aimX, aimY);
    this.setTurnGunLeft(gunBearing);
    if (Math.abs(gunBearing) < AIM_TOLERANCE && this.getGunHeat() === 0) {
      this.setFire(firepower);
    }
  }

  // --- DUEL MODE ----------------------------------------------------------

  /**
   * One enemy left. Now the orbit-and-lock duelist is the right bot: there's
   * nobody else to punish us for committing.
   */
  private duelTurn() {
    // onScannedBot steers the radar while the lock holds. If it's gone quiet we
    // lost the target, so sweep to find it again.
    if (this.getTurnNumber() - this.lastScanTurn > 3) {
      this.setTurnRadarRight(360);
    }

    const target = this.nearestEnemy();
    if (!target) return;

    const distance = this.distanceTo(target.x, target.y);

    // Orbit: turn perpendicular to the enemy, bent inward when we're too far
    // and outward when we're too close, to hold PREFERRED_RANGE.
    // Positive bearing = left, so we subtract the perpendicular offset.
    const rangeCorrection = distance > PREFERRED_RANGE ? -20 : 20;
    const perpendicular = (90 + rangeCorrection) * this.orbitDirection;
    this.setTurnLeft(this.bearingTo(target.x, target.y) - perpendicular);
    this.setForward(100 * this.orbitDirection);
  }

  // --- SHARED -------------------------------------------------------------

  override onScannedBot(e: ScannedBotEvent) {
    this.lastScanTurn = this.getTurnNumber();
    this.enemies.set(e.scannedBotId, {
      id: e.scannedBotId,
      x: e.x,
      y: e.y,
      direction: e.direction,
      speed: e.speed,
      energy: e.energy,
      lastSeenTurn: this.getTurnNumber(),
    });

    // In melee the radar keeps sweeping and the gun only wakes for close
    // threats, both handled in meleeTurn(). Nothing to do per-scan.
    if (this.isMelee()) return;

    // Duel: this event fires for one enemy, so it's safe to lock and aim here.
    // Overshoot the enemy's bearing by 2x, which keeps it inside the arc we
    // sweep next turn even as it moves.
    this.setTurnRadarLeft(this.radarBearingTo(e.x, e.y) * 2);

    const distance = this.distanceTo(e.x, e.y);
    const firepower = this.chooseFirepower(distance);
    const [aimX, aimY] = this.predictPosition(e, distance, firepower);

    const gunBearing = this.gunBearingTo(aimX, aimY);
    this.setTurnGunLeft(gunBearing);

    // Firing while the gun is still swinging wastes the shot and the heat.
    if (Math.abs(gunBearing) < AIM_TOLERANCE && this.getGunHeat() === 0) {
      this.setFire(firepower);
    }
  }

  override onBotDeath(e: BotDeathEvent) {
    // A dead bot exerts no force and is not a target.
    this.enemies.delete(e.victimId);
  }

  /** Enemies we've seen recently enough to trust the position of. */
  private livingEnemies(): EnemyState[] {
    const now = this.getTurnNumber();
    return [...this.enemies.values()].filter((e) => now - e.lastSeenTurn <= STALE_AFTER_TURNS);
  }

  /**
   * Melee target selection is its own strategic problem: nearest is convenient
   * but not best. We prefer targets that are close AND weak — finishing a
   * wounded bot removes a shooter and banks a survival place, while chipping at
   * a healthy one just refunds it energy when it hits back.
   *
   * Whoever last shot us wins a tiebreak: they've already found us, so hiding
   * from them has no value, and their bullets are the ones actually landing.
   */
  private pickTarget(): EnemyState | null {
    let best: EnemyState | null = null;
    let bestScore = Infinity;
    for (const enemy of this.livingEnemies()) {
      let score = this.distanceTo(enemy.x, enemy.y) + enemy.energy * ENERGY_WEIGHT;
      if (enemy.id === this.lastAttackerId) score -= RETALIATION_BONUS;
      if (score < bestScore) {
        bestScore = score;
        best = enemy;
      }
    }
    return best;
  }

  private nearestEnemy(): EnemyState | null {
    let best: EnemyState | null = null;
    let bestDistance = Infinity;
    for (const enemy of this.livingEnemies()) {
      const d = this.distanceTo(enemy.x, enemy.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = enemy;
      }
    }
    return best;
  }

  /**
   * Where the enemy will be when our bullet arrives, assuming it holds its
   * current heading and speed. Wrong against bots that dodge, but a big win
   * against anything that drives in a straight line.
   */
  private predictPosition(
    e: { x: number; y: number; direction: number; speed: number },
    distance: number,
    firepower: number
  ): [number, number] {
    const bulletSpeed = 20 - 3 * firepower;
    const turnsToImpact = distance / bulletSpeed;
    const heading = (e.direction * Math.PI) / 180;

    const x = e.x + Math.cos(heading) * e.speed * turnsToImpact;
    const y = e.y + Math.sin(heading) * e.speed * turnsToImpact;

    // The enemy can't drive through a wall, so a prediction outside the arena
    // is a guaranteed miss. Pull it back to where the bot could actually be.
    return [clamp(x, 18, this.getArenaWidth() - 18), clamp(y, 18, this.getArenaHeight() - 18)];
  }

  /**
   * Heavy shots up close (they land, and a hit refunds 3x the power spent),
   * light shots far away (faster bullets are harder to dodge). Back off when
   * low on energy — firing costs energy we may not be able to win back.
   */
  private chooseFirepower(distance: number): number {
    if (this.getEnergy() < 15) return 0.5;
    if (distance < 150) return 3;
    if (distance < 400) return 2;
    return 1;
  }

  override onHitByBullet(e: HitByBulletEvent) {
    // They have our range. Reversing the orbit invalidates whatever lead their
    // gun was using. In melee the force field already keeps us moving, but a
    // flip here still breaks up any pattern an enemy gun has learned.
    this.orbitDirection = -this.orbitDirection;
    this.lastAttackerId = e.bullet.ownerId;
  }

  override onHitWall(e: HitWallEvent) {
    // Pinned against a wall is how bots die. Whatever we were driving at is
    // unreachable through a wall, so drop it and let the force field re-plan.
    // (No setForward() here — it would fight the movement command the run loop
    // issues on the very next turn.)
    this.orbitDirection = -this.orbitDirection;
    this.destination = null;
  }

  override onHitBot(e: HitBotEvent) {
    // We're wedged against another tank and going nowhere. Reverse out and
    // re-plan; the force field will steer us away once we're free.
    this.destination = null;
    this.setBack(80);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Inward push from a wall `distance` away: zero beyond the margin, max at the wall. */
function wallPush(distance: number): number {
  if (distance >= WALL_MARGIN) return 0;
  return ((WALL_MARGIN - distance) / WALL_MARGIN) * WALL_STRENGTH;
}

AradfordBot.main();
