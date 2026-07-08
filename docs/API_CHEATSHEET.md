# Bot API cheatsheet

The methods and events you'll actually reach for, on one page. Full reference:
<https://robocode-dev.github.io/tank-royale/api/typescript/>.

All of these are methods on your bot (`this.forward(...)`, etc.). Import event
types from `@robocode.dev/tank-royale-bot-api`.

**Writing in Python?** Same API, snake_case names: `this.turnGunLeft(360)` →
`self.turn_gun_left(360)`, `onScannedBot` → `on_scanned_bot`, `setForward` →
`set_forward`, `isRunning()` → the `self.running` property. Import from
`robocode_tank_royale.bot_api`. Full reference:
<https://robocode-dev.github.io/tank-royale/api/python/>.

## The mental model

- Your tank has **3 parts that turn independently**: body, gun, radar.
- **You only learn where enemies are inside `onScannedBot`.** No scan = no info.
  Keep the radar moving.
- **Blocking vs. queued:** `forward()`, `turnRight()`, `fire()` etc. *block* until
  the action finishes. The `setX()` variants (`setForward`, `setTurnRight`,
  `setFire`) queue an action for the current turn and return immediately — use
  these when you want to move, turn the gun, and fire *in the same turn*.

## Movement (body)

| Method | What it does |
| ------ | ------------ |
| `forward(dist)` / `back(dist)` | Drive forward/back (blocks). |
| `turnLeft(deg)` / `turnRight(deg)` | Turn the body (blocks). |
| `setForward(dist)` / `setBack(dist)` | Queue movement for this turn. |
| `setTurnLeft(deg)` / `setTurnRight(deg)` | Queue a body turn. |
| `setMaxSpeed(s)` | Cap the speed (max is 8). |

## Gun & firing

| Method | What it does |
| ------ | ------------ |
| `turnGunLeft(deg)` / `turnGunRight(deg)` | Turn the gun (blocks). |
| `setTurnGunLeft/Right(deg)` | Queue a gun turn. |
| `fire(power)` | Fire (blocks). `power` is 0.1–3.0. |
| `setFire(power)` | Queue a shot for this turn. Returns `true` if it will fire. |
| `getGunHeat()` | Gun can only fire when this is `0`. |

**Firepower tradeoffs:** higher power = more damage + more energy back on hit, but
slower bullet and more gun heat. `bulletSpeed = 20 - 3 * power`. You gain `3 * power`
energy when you hit; you spend `power` to fire.

## Radar (scanning)

| Method | What it does |
| ------ | ------------ |
| `turnRadarLeft/Right(deg)` | Turn the radar (blocks). |
| `setTurnRadarLeft/Right(deg)` | Queue a radar turn. |
| `setAdjustRadarForBodyTurn(true)` | Radar turns independently of the body. |
| `setAdjustRadarForGunTurn(true)` | Radar turns independently of the gun. |
| `setAdjustGunForBodyTurn(true)` | Gun turns independently of the body. |

Radar range is 1200 px and it only detects bots inside the arc it *swept this turn*.

## Sensing / geometry helpers

| Method | Returns |
| ------ | ------- |
| `getX()`, `getY()` | Your position. |
| `getDirection()`, `getGunDirection()`, `getRadarDirection()` | Headings (deg). |
| `getEnergy()`, `getSpeed()`, `getGunHeat()` | Your state. |
| `getEnemyCount()` | Bots still alive (besides you). |
| `getArenaWidth()`, `getArenaHeight()` | Battlefield size. |
| `distanceTo(x, y)` | Distance to a point. |
| `bearingTo(x, y)` | Body-relative bearing to a point (deg, -180..180). |
| `gunBearingTo(x, y)` | Gun-relative bearing (how far to turn the gun). |
| `radarBearingTo(x, y)` | Radar-relative bearing. |
| `calcBearing(dir)` | Convert an absolute direction to a body-relative bearing. |

## Events you can override

| Event handler | Fires when… |
| ------------- | ----------- |
| `run()` | The round starts — your main loop. |
| `onScannedBot(e: ScannedBotEvent)` | You scan an enemy. `e.x, e.y, e.direction, e.speed, e.energy`. |
| `onHitByBullet(e: HitByBulletEvent)` | A bullet hits you. `e.bullet.direction`, `e.damage`. |
| `onHitBot(e: HitBotEvent)` | You collide with another bot. `e.isRammed`, `e.x, e.y`. |
| `onHitWall(e: HitWallEvent)` | You drive into a wall. |
| `onBulletHit(e: BulletHitBotEvent)` | Your bullet hits an enemy. |
| `onDeath(e: DeathEvent)` | Your bot is destroyed. |
| `onWonRound(e: WonRoundEvent)` | You win the round. |

## A solid starting pattern

```ts
import { Bot, ScannedBotEvent, HitByBulletEvent } from "@robocode.dev/tank-royale-bot-api";

// Folder/files are aburns-bot.*, but the class name is PascalCase (no hyphens).
class AburnsBot extends Bot {
  static main() { new AburnsBot().start(); }

  override run() {
    this.setAdjustRadarForGunTurn(true);
    this.setAdjustGunForBodyTurn(true);
    while (this.isRunning()) {
      this.turnRadarRight(360);   // search until we see someone
    }
  }

  override onScannedBot(e: ScannedBotEvent) {
    // Lock the radar onto the target so we scan it every turn.
    this.setTurnRadarLeft(-this.radarBearingTo(e.x, e.y) * 2);
    // Point the gun at the target and fire if lined up & cool.
    const gb = this.gunBearingTo(e.x, e.y);
    this.setTurnGunLeft(-gb);
    if (Math.abs(gb) < 8 && this.getGunHeat() === 0) this.setFire(2);
    // Strafe so we're a moving target.
    this.setTurnRight(this.bearingTo(e.x, e.y) + 90);
    this.setForward(100);
  }

  override onHitByBullet(e: HitByBulletEvent) {
    this.setForward(-100); // reverse to dodge
  }
}

AburnsBot.main();
```

See `bots/Hunter/Hunter.ts` for a fuller version with predictive aiming.
