import { Color } from "@robocode.dev/tank-royale-bot-api";
import type { IGraphics } from "@robocode.dev/tank-royale-bot-api";
import { GameState } from "./state.ts";
import { Surfer } from "./surf.ts";
import { project, DEG, normalizeAbsolute } from "./geom.ts";

/**
 * The HUD. Draws the read on the opponent, the incoming bullet
 * waves it's dodging, the dodge sweep, and the killing line to the gun's
 * target. Pure style on top of the fight — none of it changes the tank's play.
 */

const CRIMSON = Color.fromRgb(200, 30, 48);
const GOLD = Color.fromRgb(240, 195, 70);
const BONE = Color.fromRgb(235, 230, 220);
const SHADOW = Color.fromRgba(0, 0, 0, 150);

export function paintColors(bot: {
  setBodyColor: (c: Color) => void;
  setTurretColor: (c: Color) => void;
  setGunColor: (c: Color) => void;
  setRadarColor: (c: Color) => void;
  setBulletColor: (c: Color) => void;
  setScanColor: (c: Color) => void;
  setTracksColor: (c: Color) => void;
}): void {
  bot.setBodyColor(CRIMSON);
  bot.setTurretColor(Color.fromRgb(90, 0, 10));
  bot.setGunColor(GOLD);
  bot.setRadarColor(GOLD);
  bot.setBulletColor(GOLD);
  bot.setScanColor(Color.fromRgba(200, 30, 48, 90));
  bot.setTracksColor(Color.fromRgb(60, 0, 8));
}

export function paintHud(
  g: IGraphics,
  gs: GameState,
  surfer: Surfer,
  read: string,
  gunName: string,
  aimAngle: number,
): void {
  g.clear();
  const me = gs.me;

  // --- incoming bullet waves -----------------------------------------
  for (const w of surfer.activeWaves()) {
    const radius = (me.time - w.fireTime) * w.bSpeed;
    if (radius <= 0) continue;
    const heat = Math.min(255, 80 + w.power * 55);
    g.setStrokeColor(Color.fromRgba(255, Math.round(heat), 40, 170));
    g.setStrokeWidth(1.5);
    g.drawCircle(w.originX, w.originY, radius);

    // The Mirror Mind's read: crimson horns marking exactly where the enemy's
    // statistical gun aimed this wave. 
    if (w.mirrorGfs) {
      g.setFillColor(CRIMSON);
      for (const gf of w.mirrorGfs) {
        const ang = w.refAngle + gf * w.lateralDir * w.mea * DEG;
        const p = project(w.originX, w.originY, ang, radius);
        g.fillCircle(p.x, p.y, 5);
      }
    }
  }

  // --- dodge sweep: which way we're going ------------------------------
  const od = surfer.lastChosenDir;
  if (od !== 0) {
    const heading = normalizeAbsolute(me.direction + (od > 0 ? 90 : -90));
    const tip = project(me.x, me.y, heading, 55);
    g.setStrokeColor(CRIMSON);
    g.setStrokeWidth(3);
    g.drawLine(me.x, me.y, tip.x, tip.y);
    g.setFillColor(Color.fromRgba(200, 30, 48, 120));
    g.fillCircle(tip.x, tip.y, 7);
  }

  // --- the firing line -----------------------------
  if (gs.seenEnemy) {
    const end = project(me.x, me.y, aimAngle, 1300);
    g.setStrokeColor(Color.fromRgba(240, 195, 70, 140));
    g.setStrokeWidth(1);
    g.drawLine(me.x, me.y, end.x, end.y);
    // Reticle on the enemy.
    g.setStrokeColor(GOLD);
    g.setStrokeWidth(2);
    g.drawCircle(gs.enemy.x, gs.enemy.y, 26);
    g.drawLine(gs.enemy.x - 34, gs.enemy.y, gs.enemy.x - 20, gs.enemy.y);
    g.drawLine(gs.enemy.x + 20, gs.enemy.y, gs.enemy.x + 34, gs.enemy.y);
  }

  // --- the signature card ----------------------------------------------
  const bx = me.x - 46;
  const by = me.y + 34;
  g.setFillColor(SHADOW);
  g.fillRectangle(bx, by, 150, 34);
  g.setStrokeColor(GOLD);
  g.setStrokeWidth(1);
  g.drawRectangle(bx, by, 150, 34);
  g.setFont("monospace", 11);
  g.setFillColor(GOLD);
  g.drawText("◆ JBOSLEY-BOT", bx + 8, by + 22);
  g.setFont("monospace", 8);
  g.setFillColor(BONE);
  g.drawText(`${read}  •  ${gunName}`, bx + 8, by + 9);
}
