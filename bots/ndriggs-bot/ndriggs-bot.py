"""ndriggs-bot — deep-RL Robocode Tank Royale bot.

The movement + firing policy is a neural network trained with MuZero
(opendilab/LightZero) via league self-play in a bit-exact Python re-implementation
of the Tank Royale v1.0.2 physics (mixed 1v1 + 4-bot-melee training). At runtime
the bot runs the exported policy network (TorchScript) every other turn; radar
lock, 2nd-order predictive gun tracking and multi-enemy modeling are
deterministic reflexes.

Weights are downloaded from HuggingFace on first boot (cached afterwards):
    https://huggingface.co/ml-at-redo1/robocode-tank-rl
Override for local testing:  NDRIGGS_MODEL_PATH=/path/to/actor.pt

NOTE: the Harness section below is a verbatim mirror of rl-training/tanksim/
harness.py (the training-time harness). If one changes, the other must too.
"""

from __future__ import annotations

import math
import os
import random as _random
import sys
from dataclasses import dataclass, field

import numpy as np
import torch

from robocode_tank_royale.bot_api.bot import Bot
from robocode_tank_royale.bot_api.events import (
    BotDeathEvent,
    BulletHitBotEvent,
    HitByBulletEvent,
    HitBotEvent,
    HitWallEvent,
    RoundStartedEvent,
    ScannedBotEvent,
    TickEvent,
)

torch.set_num_threads(1)

# ── constants (tank-royale v1.0.2 rules.kt) ──────────────────────────────────

ARENA_WIDTH = 800.0
ARENA_HEIGHT = 600.0
BOT_RADIUS = 18.0
MAX_GUN_TURN_RATE = 20.0
MAX_RADAR_TURN_RATE = 45.0

GUN_LEAD_NOMINAL = 0.65
GUN_LEAD_RANGE = (0.25, 1.0)
SCAN_STALE_LIMIT = 12
ENEMY_ALIVE_LIMIT = 40
MELEE_SWEEP_INTERVAL = 110

TURN_OPTIONS = (-10.0, -4.0, 0.0, 4.0, 10.0)
SPEED_OPTIONS = (-8.0, 0.0, 8.0)
FIRE_OPTIONS = (0.0, 1.0, 3.0)
FIRE_AUTO = 1.0
NUM_ACTIONS = len(TURN_OPTIONS) * len(SPEED_OPTIONS) * len(FIRE_OPTIONS)

HF_REPO_ID = "ml-at-redo1/robocode-tank-rl"


def calc_bullet_speed(firepower: float) -> float:
    return 20.0 - 3.0 * min(max(firepower, 0.1), 3.0)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def norm_rel(angle: float) -> float:
    a = math.fmod(angle, 360.0)
    if a >= 0:
        return a if a < 180 else a - 360.0
    return a if a >= -180 else a + 360.0


def decode_action(action: int):
    turn_idx, rest = divmod(action, len(SPEED_OPTIONS) * len(FIRE_OPTIONS))
    speed_idx, fire_idx = divmod(rest, len(FIRE_OPTIONS))
    return TURN_OPTIONS[turn_idx], SPEED_OPTIONS[speed_idx], FIRE_OPTIONS[fire_idx]


# ── harness (mirror of rl-training/tanksim/harness.py) ───────────────────────


@dataclass
class MyState:
    x: float
    y: float
    direction: float
    gun_direction: float
    radar_direction: float
    speed: float
    energy: float
    gun_heat: float
    enemy_count: int = 1


@dataclass
class TickEvents:
    scanned: list = field(default_factory=list)  # [(id, x, y, dir, speed, energy)]
    hit_by_bullets: list = field(default_factory=list)  # [(power, dir, dmg, shooter_id)]
    my_bullet_hits: list = field(default_factory=list)  # [(power, dmg, victim_id)]
    enemies_died: list = field(default_factory=list)
    hit_wall: bool = False
    hit_bot: bool = False


@dataclass
class IncomingBullet:
    origin_x: float
    origin_y: float
    speed: float
    power: float
    fired_turn: int


@dataclass
class EnemyModel:
    x: float
    y: float
    direction: float = 0.0
    speed: float = 0.0
    energy: float = 100.0
    last_scan_turn: int = -999
    prev_scan_energy: float | None = None
    prev_scan_turn: int = -999
    damage_dealt_since_scan: float = 0.0
    energy_given_since_scan: float = 0.0
    scan_history: list = field(default_factory=list)


class Harness:
    def __init__(self, obs_mode: str = "threat"):
        self.obs_mode = obs_mode
        self.obs_dim = 35 if obs_mode == "threat" else 24
        self.rng = _random.Random()
        self.reset()

    def reset(self) -> None:
        self.turn = 0
        self.enemies = {}
        self.target_id = None
        self.incoming = None
        self.enemy_fired_recently = 0.0
        self.last_firepower = 0.0
        self.current_lead = GUN_LEAD_NOMINAL
        self._was_gun_hot = True
        self._last_sweep_turn = 0
        self._sweep_until = 0

    @property
    def enemy_known(self) -> bool:
        return self.target_id is not None

    def _target(self):
        return self.enemies.get(self.target_id) if self.target_id is not None else None

    @property
    def enemy_x(self):
        t = self._target()
        return t.x if t else ARENA_WIDTH / 2

    @property
    def enemy_y(self):
        t = self._target()
        return t.y if t else ARENA_HEIGHT / 2

    @property
    def enemy_direction(self):
        t = self._target()
        return t.direction if t else 0.0

    @property
    def enemy_speed(self):
        t = self._target()
        return t.speed if t else 0.0

    @property
    def enemy_energy(self):
        t = self._target()
        return t.energy if t else 100.0

    @property
    def last_scan_turn(self):
        t = self._target()
        return t.last_scan_turn if t else -999

    def observe_tick(self, me: MyState, ev: TickEvents) -> None:
        self.turn += 1

        for bot_id in ev.enemies_died:
            self.enemies.pop(bot_id, None)

        for power, damage, victim_id in ev.my_bullet_hits:
            if victim_id in self.enemies:
                self.enemies[victim_id].damage_dealt_since_scan += damage
        for power, _direction, _damage, shooter_id in ev.hit_by_bullets:
            if shooter_id in self.enemies:
                self.enemies[shooter_id].energy_given_since_scan += 3.0 * power

        for (bot_id, sx, sy, sdir, sspeed, senergy) in ev.scanned:
            e = self.enemies.get(bot_id)
            if e is None:
                e = self.enemies[bot_id] = EnemyModel(x=sx, y=sy)
            if e.prev_scan_energy is not None:
                expected = (
                    e.prev_scan_energy - e.damage_dealt_since_scan + e.energy_given_since_scan
                )
                drop = expected - senergy
                if 0.09 <= drop <= 3.01:
                    self.incoming = IncomingBullet(
                        origin_x=e.x, origin_y=e.y, speed=calc_bullet_speed(drop),
                        power=drop, fired_turn=e.prev_scan_turn,
                    )
                    self.enemy_fired_recently = 1.0
            e.x, e.y = sx, sy
            e.direction = sdir
            e.speed = sspeed
            e.energy = senergy
            e.prev_scan_energy = senergy
            e.prev_scan_turn = self.turn
            e.last_scan_turn = self.turn
            e.damage_dealt_since_scan = 0.0
            e.energy_given_since_scan = 0.0
            e.scan_history.append((self.turn, sx, sy))
            if len(e.scan_history) > 3:
                e.scan_history.pop(0)

        for bot_id, e in list(self.enemies.items()):
            if self.turn - e.last_scan_turn > ENEMY_ALIVE_LIMIT:
                del self.enemies[bot_id]
                continue
            if e.last_scan_turn != self.turn:
                a = math.radians(e.direction)
                e.x = clamp(e.x + math.cos(a) * e.speed, BOT_RADIUS, ARENA_WIDTH - BOT_RADIUS)
                e.y = clamp(e.y + math.sin(a) * e.speed, BOT_RADIUS, ARENA_HEIGHT - BOT_RADIUS)

        best_id, best_score = None, float("inf")
        for bot_id, e in self.enemies.items():
            d = math.hypot(e.x - me.x, e.y - me.y)
            score = d * (0.75 + 0.25 * clamp(e.energy, 0, 100) / 100.0)
            if score < best_score:
                best_id, best_score = bot_id, score
        self.target_id = best_id

        self.enemy_fired_recently *= 0.9
        if self.incoming is not None:
            b = self.incoming
            dist_to_me = math.hypot(me.x - b.origin_x, me.y - b.origin_y)
            traveled = b.speed * (self.turn - b.fired_turn)
            if traveled > dist_to_me + 60:
                self.incoming = None

    def auto_intents(self, me: MyState):
        in_melee = me.enemy_count > 1
        if in_melee and self.turn - self._last_sweep_turn > MELEE_SWEEP_INTERVAL:
            self._last_sweep_turn = self.turn
            self._sweep_until = self.turn + 8

        staleness = self.turn - self.last_scan_turn
        if self.turn < self._sweep_until or not self.enemy_known or staleness > SCAN_STALE_LIMIT:
            radar_rate = MAX_RADAR_TURN_RATE
        else:
            rb = self._bearing_from(me.x, me.y, me.radar_direction, self.enemy_x, self.enemy_y)
            radar_rate = clamp(2.0 * rb, -MAX_RADAR_TURN_RATE, MAX_RADAR_TURN_RATE)

        gun_hot = me.gun_heat > 0
        if self._was_gun_hot and not gun_hot:
            self.current_lead = self.rng.uniform(*GUN_LEAD_RANGE)
        self._was_gun_hot = gun_hot

        aim_x, aim_y = self.aim_point(me, self.current_lead)
        gb = self._bearing_from(me.x, me.y, me.gun_direction, aim_x, aim_y)
        gun_rate = clamp(gb, -MAX_GUN_TURN_RATE, MAX_GUN_TURN_RATE)
        return gun_rate, radar_rate, False

    def _predict_enemy(self, future_turns: float):
        t_model = self._target()
        if t_model is None:
            return self.enemy_x, self.enemy_y
        h = t_model.scan_history
        if len(h) < 2:
            a = math.radians(t_model.direction)
            return (t_model.x + math.cos(a) * t_model.speed * future_turns,
                    t_model.y + math.sin(a) * t_model.speed * future_turns)
        (tb, bx, by), (ta, ax, ay) = h[-2], h[-1]
        dt_ab = max(ta - tb, 1)
        vx = (ax - bx) / dt_ab
        vy = (ay - by) / dt_ab
        acc_x = acc_y = 0.0
        if len(h) == 3:
            (tc, cx, cy) = h[-3]
            dt_bc = max(tb - tc, 1)
            if dt_ab <= 60 and dt_bc <= 60:
                pvx = (bx - cx) / dt_bc
                pvy = (by - cy) / dt_bc
                acc_x = (vx - pvx) / dt_ab
                acc_y = (vy - pvy) / dt_ab
        t = future_turns + (self.turn - h[-1][0])
        return (ax + vx * t + 0.5 * acc_x * t * t,
                ay + vy * t + 0.5 * acc_y * t * t)

    def aim_point(self, me: MyState, lead: float = GUN_LEAD_NOMINAL):
        if not self.enemy_known:
            return self.enemy_x, self.enemy_y
        fut_x, fut_y = self.enemy_x, self.enemy_y
        for _ in range(4):
            distance = math.hypot(fut_x - me.x, fut_y - me.y)
            power = self.resolve_firepower(FIRE_AUTO, me)
            t = distance / calc_bullet_speed(power)
            fut_x, fut_y = self._predict_enemy(t)
        lead_x = self.enemy_x + (fut_x - self.enemy_x) * lead
        lead_y = self.enemy_y + (fut_y - self.enemy_y) * lead
        lead_x = clamp(lead_x, BOT_RADIUS, ARENA_WIDTH - BOT_RADIUS)
        lead_y = clamp(lead_y, BOT_RADIUS, ARENA_HEIGHT - BOT_RADIUS)
        return lead_x, lead_y

    def resolve_firepower(self, fire_option: float, me: MyState) -> float:
        if fire_option == 0.0:
            return 0.0
        if fire_option == FIRE_AUTO:
            if not self.enemy_known:
                return 0.0
            distance = math.hypot(self.enemy_x - me.x, self.enemy_y - me.y)
            return clamp(450.0 / max(distance, 1.0), 0.15, 3.0)
        return fire_option

    @staticmethod
    def _bearing_from(x, y, heading, tx, ty) -> float:
        return norm_rel(math.degrees(math.atan2(ty - y, tx - x)) - heading)

    def build_obs(self, me: MyState) -> np.ndarray:
        staleness = min(self.turn - self.last_scan_turn, 30) if self.enemy_known else 30
        dx = self.enemy_x - me.x
        dy = self.enemy_y - me.y
        distance = math.hypot(dx, dy)
        abs_bearing = math.degrees(math.atan2(dy, dx))
        rel_bearing = norm_rel(abs_bearing - me.direction)
        aim_x, aim_y = self.aim_point(me)
        gun_err = self._bearing_from(me.x, me.y, me.gun_direction, aim_x, aim_y)

        enemy_dir_rad = math.radians(self.enemy_direction)
        abs_bearing_rad = math.radians(abs_bearing)
        along = math.cos(enemy_dir_rad - abs_bearing_rad) * self.enemy_speed
        lateral = math.sin(enemy_dir_rad - abs_bearing_rad) * self.enemy_speed

        my_dir_rad = math.radians(me.direction)
        wall_ahead = self._wall_distance_along(me.x, me.y, my_dir_rad)

        obs = [
            me.x / ARENA_WIDTH,
            me.y / ARENA_HEIGHT,
            math.cos(my_dir_rad),
            math.sin(my_dir_rad),
            me.speed / 8.0,
            me.energy / 100.0,
            me.gun_heat / 1.6,
            gun_err / 180.0,
            1.0 if self.enemy_known else 0.0,
            staleness / 30.0,
            distance / 1000.0,
            math.cos(abs_bearing_rad),
            math.sin(abs_bearing_rad),
            rel_bearing / 180.0,
            self.enemy_energy / 100.0,
            math.cos(enemy_dir_rad),
            math.sin(enemy_dir_rad),
            self.enemy_speed / 8.0,
            lateral / 8.0,
            along / 8.0,
            wall_ahead / 800.0,
            min(me.x, ARENA_WIDTH - me.x) / 400.0,
            min(me.y, ARENA_HEIGHT - me.y) / 300.0,
            min(self.turn, 1250) / 1250.0,
        ]

        if self.obs_mode == "threat":
            if self.incoming is not None:
                b = self.incoming
                bdist = math.hypot(me.x - b.origin_x, me.y - b.origin_y)
                traveled = b.speed * (self.turn - b.fired_turn)
                tti = (bdist - traveled) / b.speed
                borigin_bearing = self._bearing_from(me.x, me.y, me.direction, b.origin_x, b.origin_y)
                obs += [
                    1.0,
                    b.power / 3.0,
                    clamp(tti, 0.0, 40.0) / 40.0,
                    math.cos(math.radians(borigin_bearing)),
                    math.sin(math.radians(borigin_bearing)),
                ]
            else:
                obs += [0.0, 0.0, 1.0, 0.0, 0.0]
            my_lateral = math.sin(my_dir_rad - abs_bearing_rad) * me.speed
            my_along = math.cos(my_dir_rad - abs_bearing_rad) * me.speed
            obs += [
                my_lateral / 8.0,
                my_along / 8.0,
                self.enemy_fired_recently,
                self.last_firepower / 3.0,
            ]
            second_dist = 1.0
            if len(self.enemies) > 1:
                dists = sorted(
                    math.hypot(e.x - me.x, e.y - me.y) for e in self.enemies.values()
                )
                second_dist = min(dists[1] / 1000.0, 1.0)
            obs += [
                max(me.enemy_count - 1, 0) / 3.0,
                second_dist if len(self.enemies) > 1 else 1.0,
            ]

        return np.asarray(obs, dtype=np.float32)

    @staticmethod
    def _wall_distance_along(x: float, y: float, heading_rad: float) -> float:
        cx = math.cos(heading_rad)
        cy = math.sin(heading_rad)
        dists = []
        if cx > 1e-9:
            dists.append((ARENA_WIDTH - x) / cx)
        elif cx < -1e-9:
            dists.append(-x / cx)
        if cy > 1e-9:
            dists.append((ARENA_HEIGHT - y) / cy)
        elif cy < -1e-9:
            dists.append(-y / cy)
        return min(dists) if dists else 800.0


# ── deployment MCTS (mirror of rl-training/tanksim/deploy_mcts.py) ───────────


def support_to_scalar(logits: torch.Tensor, epsilon: float = 0.001) -> float:
    n = logits.shape[1]
    half = (n - 1) // 2
    support = torch.arange(-half, half + 1, dtype=torch.float32)
    probs = torch.softmax(logits[0], dim=0)
    value = float((probs * support).sum())
    tmp = (math.sqrt(1 + 4 * epsilon * (abs(value) + 1 + epsilon)) - 1) / (2 * epsilon)
    return math.copysign(tmp * tmp - 1, value)


class _MinMax:
    def __init__(self):
        self.mn = float("inf")
        self.mx = float("-inf")

    def update(self, v):
        self.mn = min(self.mn, v)
        self.mx = max(self.mx, v)

    def normalize(self, v):
        if self.mx > self.mn:
            return (v - self.mn) / (self.mx - self.mn)
        return v


class _Node:
    __slots__ = ("prior", "visit_count", "value_sum", "reward", "latent", "children")

    def __init__(self, prior):
        self.prior = prior
        self.visit_count = 0
        self.value_sum = 0.0
        self.reward = 0.0
        self.latent = None
        self.children = {}

    def value(self):
        return self.value_sum / self.visit_count if self.visit_count else 0.0


class DeployMCTS:
    def __init__(self, init_path, rec_path, num_actions, discount=0.997,
                 c1=1.25, c2=19652.0):
        self.init_net = torch.jit.load(init_path, map_location="cpu")
        self.init_net.eval()
        self.rec_net = torch.jit.load(rec_path, map_location="cpu")
        self.rec_net.eval()
        self.num_actions = num_actions
        self.discount = discount
        self.c1 = c1
        self.c2 = c2
        self._eye = torch.eye(num_actions, dtype=torch.float32)

    @torch.no_grad()
    def run(self, obs, num_simulations=24) -> int:
        t = torch.as_tensor(obs, dtype=torch.float32).reshape(1, -1)
        latent, logits, value_logits = self.init_net(t)
        root = _Node(0.0)
        root.latent = latent
        self._expand(root, logits)
        root.visit_count = 1
        root.value_sum = support_to_scalar(value_logits)
        minmax = _MinMax()

        for _ in range(num_simulations):
            node = root
            path = [root]
            actions = []
            while node.latent is not None:
                action, child = self._select(node, minmax)
                actions.append(action)
                path.append(child)
                node = child

            parent = path[-2]
            a_onehot = self._eye[actions[-1]].unsqueeze(0)
            next_latent, reward_logits, logits, value_logits = self.rec_net(
                parent.latent, a_onehot
            )
            node.latent = next_latent
            node.reward = support_to_scalar(reward_logits)
            self._expand(node, logits)

            value = support_to_scalar(value_logits)
            for n in reversed(path):
                n.value_sum += value
                n.visit_count += 1
                minmax.update(n.reward + self.discount * n.value())
                value = n.reward + self.discount * value

        return max(root.children, key=lambda a: root.children[a].visit_count)

    def _expand(self, node, policy_logits):
        priors = torch.softmax(policy_logits[0], dim=0)
        for a in range(self.num_actions):
            node.children[a] = _Node(float(priors[a]))

    def _select(self, node, minmax):
        total = max(1, node.visit_count)
        pb_c = math.log((total + self.c2 + 1) / self.c2) + self.c1
        sqrt_total = math.sqrt(total)
        best_score = -1e18
        best_a = 0
        for a, child in node.children.items():
            q = minmax.normalize(child.reward + self.discount * child.value()) if child.visit_count else 0.0
            score = q + pb_c * child.prior * sqrt_total / (1 + child.visit_count)
            if score > best_score:
                best_score = score
                best_a = a
        return best_a, node.children[best_a]


# ── model loading ─────────────────────────────────────────────────────────────


def load_policy():
    """Returns (decide_fn: obs -> action int, config dict)."""
    local = os.environ.get("NDRIGGS_MODEL_PATH")
    if local:
        config = dict(
            mode="policy",
            obs_mode=os.environ.get("NDRIGGS_OBS_MODE", "threat"),
            frame_skip=int(os.environ.get("NDRIGGS_FRAME_SKIP", "2")),
        )
        module = torch.jit.load(local, map_location="cpu")
        module.eval()
        print(f"ndriggs-bot: local policy {local}", file=sys.stderr)

        def decide(obs):
            with torch.no_grad():
                logits = module(torch.from_numpy(obs).reshape(1, -1))[0]
            return int(torch.argmax(logits).item())

        return decide, config

    import json

    from huggingface_hub import hf_hub_download

    cfg_path = hf_hub_download(repo_id=HF_REPO_ID, filename="config.json")
    with open(cfg_path) as f:
        config = json.load(f)
    print(f"ndriggs-bot: HF config {config}", file=sys.stderr)

    if config.get("mode") == "mcts":
        init_p = hf_hub_download(repo_id=HF_REPO_ID, filename="actor.init.pt")
        rec_p = hf_hub_download(repo_id=HF_REPO_ID, filename="actor.rec.pt")
        mcts = DeployMCTS(init_p, rec_p, int(config.get("num_actions", NUM_ACTIONS)))
        sims = int(config.get("num_simulations", 24))

        def decide(obs):
            return mcts.run(obs, sims)

        return decide, config

    actor_p = hf_hub_download(repo_id=HF_REPO_ID, filename="actor.pt")
    module = torch.jit.load(actor_p, map_location="cpu")
    module.eval()

    def decide(obs):
        with torch.no_grad():
            logits = module(torch.from_numpy(obs).reshape(1, -1))[0]
        return int(torch.argmax(logits).item())

    return decide, config


# ── the bot ───────────────────────────────────────────────────────────────────


class NdriggsBot(Bot):
    def __init__(self):
        super().__init__()
        self.decide, config = load_policy()
        self.harness = Harness(config.get("obs_mode", "threat"))
        self.frame_skip = int(config.get("frame_skip", 2))
        self.decision_turn = 0
        self.turn_rate_cmd = 0.0
        self.target_speed_cmd = 0.0
        self.firepower_cmd = 0.0

    def run(self) -> None:
        # all decision logic lives in on_tick (dispatched inside go())
        while self.running:
            self.go()

    def on_round_started(self, e: RoundStartedEvent) -> None:
        self.harness.reset()
        self.decision_turn = 0
        self.turn_rate_cmd = 0.0
        self.target_speed_cmd = 0.0
        self.firepower_cmd = 0.0

    def on_tick(self, e: TickEvent) -> None:
        bs = e.bot_state
        if bs is None:
            return
        me = MyState(
            x=bs.x, y=bs.y, direction=bs.direction, gun_direction=bs.gun_direction,
            radar_direction=bs.radar_direction, speed=bs.speed, energy=bs.energy,
            gun_heat=bs.gun_heat, enemy_count=max(bs.enemy_count, 1),
        )

        ev = TickEvents()
        for event in e.events:
            if isinstance(event, ScannedBotEvent):
                ev.scanned.append((
                    event.scanned_bot_id, event.x, event.y,
                    event.direction, event.speed, event.energy,
                ))
            elif isinstance(event, HitByBulletEvent):
                ev.hit_by_bullets.append((
                    event.bullet.power, event.bullet.direction, event.damage,
                    event.bullet.owner_id,
                ))
            elif isinstance(event, BulletHitBotEvent):
                ev.my_bullet_hits.append((event.bullet.power, event.damage, event.victim_id))
            elif isinstance(event, BotDeathEvent):
                ev.enemies_died.append(event.victim_id)
            elif isinstance(event, HitWallEvent):
                ev.hit_wall = True
            elif isinstance(event, HitBotEvent):
                ev.hit_bot = True

        self.harness.observe_tick(me, ev)

        # policy decision every frame_skip turns
        if self.decision_turn % self.frame_skip == 0:
            obs = self.harness.build_obs(me)
            action = self.decide(obs)
            self.turn_rate_cmd, self.target_speed_cmd, self.firepower_cmd = decode_action(action)
            self.harness.last_firepower = self.firepower_cmd
        self.decision_turn += 1

        gun_rate, radar_rate, _rescan = self.harness.auto_intents(me)

        # commit intent (adjust flags mirror training; fire assist is implicitly
        # disabled by adjust_radar_for_gun_turn = True)
        self.adjust_gun_for_body_turn = True
        self.adjust_radar_for_gun_turn = True
        self.adjust_radar_for_body_turn = True
        self.turn_rate = self.turn_rate_cmd
        self.target_speed = self.target_speed_cmd
        self.gun_turn_rate = gun_rate
        self.radar_turn_rate = radar_rate
        resolved_fp = self.harness.resolve_firepower(self.firepower_cmd, me)
        if resolved_fp > 0:
            self.set_fire(resolved_fp)


if __name__ == "__main__":
    NdriggsBot().start()
