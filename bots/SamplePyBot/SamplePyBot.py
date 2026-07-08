"""
SamplePyBot — the "hello world" of Robocode Tank Royale, in Python.

This is the Python twin of SampleBot (TypeScript): deliberately simple and
heavily commented. Copy it with `npm run new-bot -- yourname-bot --python`
and start experimenting.

A bot is a tank with three independently-rotating parts:
  - body   (moves the tank, slowest to turn)
  - gun    (fires bullets, mounted on the body)
  - radar  (scans for enemies, mounted on the gun, fastest to turn)

The game calls run() once at the start of each round. Everything else
happens in on_<event>() handlers that fire when things happen in the arena.
"""
from robocode_tank_royale.bot_api.bot import Bot
from robocode_tank_royale.bot_api.events import ScannedBotEvent, HitByBulletEvent, HitWallEvent


class SamplePyBot(Bot):
    # Called when a new round begins. Put your main loop here.
    def run(self) -> None:
        # Loop until the round ends. If you leave run(), your bot can only
        # react via event handlers — so keep looping while self.running.
        while self.running:
            self.forward(100)
            self.turn_gun_left(360)  # sweep the gun+radar all the way around to find enemies
            self.back(100)
            self.turn_gun_left(360)

    # Fires whenever our radar sweeps across an enemy. This is the ONLY time
    # we learn where an enemy is, so most bot logic lives here.
    def on_scanned_bot(self, e: ScannedBotEvent) -> None:
        # fire(power): 0.1 (weak, fast, cheap) .. 3.0 (strong, slow, expensive).
        # Firing costs energy; hitting an enemy refunds 3x the power you spent.
        self.fire(1)

    # Fires when an enemy bullet hits us — try to dodge by turning side-on.
    def on_hit_by_bullet(self, e: HitByBulletEvent) -> None:
        bearing = self.calc_bearing(e.bullet.direction)
        self.turn_right(90 - bearing)

    # Fires when we drive into a wall — back away and turn so we don't get stuck.
    def on_hit_wall(self, e: HitWallEvent) -> None:
        self.back(50)
        self.turn_right(45)


if __name__ == "__main__":
    SamplePyBot().start()
