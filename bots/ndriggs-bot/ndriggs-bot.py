"""ndriggs-bot — deep-RL Robocode Tank Royale bot.

The movement + firing policy is a neural network trained with MuZero
(opendilab/LightZero) via self-play + a scripted-opponent league in a faithful
Python re-implementation of the Tank Royale v1.0.2 physics. At runtime the bot
runs the exported policy network (TorchScript) every other turn; radar lock,
linear-lead gun tracking and enemy modeling are deterministic reflexes.

Weights are downloaded from HuggingFace on first boot (cached afterwards):
    https://huggingface.co/ndriggs/robocode-tank-rl
Override for local testing:  NDRIGGS_MODEL_PATH=/path/to/actor.pt

NOTE: the Harness section below is a verbatim mirror of rl-training/tanksim/
harness.py (the training-time harness). If one changes, the other must too.
"""

from __future__ import annotations

import math
import os
import sys
from dataclasses import dataclass, field

import numpy as np
import torch

from robocode_tank_royale.bot_api.bot import Bot
from robocode_tank_royale.bot_api.events import (
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

GUN_LEAD = 0.6
SCAN_STALE_LIMIT = 12

TURN_OPTIONS = (-10.0, -4.0, 0.0, 4.0, 10.0)
SPEED_OPTIONS = (-8.0, 0.0, 8.0)
FIRE_OPTIONS = (0.0, 1.0, 3.0)
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


@dataclass
class TickEvents:
    scanned_x: float | None = None
    scanned_y: float | None = None
    scanned_direction: float = 0.0
    scanned_speed: float = 0.0
    scanned_energy: float = 100.0
    hit_by_bullets: list = field(default_factory=list)
    my_bullet_hits: list = field(default_factory=list)
    hit_wall: bool = False
    hit_bot: bool = False


@dataclass
class IncomingBullet:
    origin_x: float
    origin_y: float
    speed: float
    power: float
    fired_turn: int


class Harness:
    def __init__(self, obs_mode: str = "threat"):
        self.obs_mode = obs_mode
        self.obs_dim = 33 if obs_mode == "threat" else 24
        self.reset()

    def reset(self) -> None:
        self.turn = 0
        self.enemy_known = False
        self.enemy_x = ARENA_WIDTH / 2
        self.enemy_y = ARENA_HEIGHT / 2
        self.enemy_direction = 0.0
        self.enemy_speed = 0.0
        self.enemy_energy = 100.0
        self.last_scan_turn = -999
        self.prev_scan_energy = None
        self.prev_scan_turn = -999
        self.damage_dealt_since_scan = 0.0
        self.energy_given_since_scan = 0.0
        self.incoming = None
        self.enemy_fired_recently = 0.0
        self.last_firepower = 0.0

    def observe_tick(self, me: MyState, ev: TickEvents) -> None:
        self.turn += 1
        for power, damage in ev.my_bullet_hits:
            self.damage_dealt_since_scan += damage
        for power, _direction, _damage in ev.hit_by_bullets:
            self.energy_given_since_scan += 3.0 * power

        if ev.scanned_x is not None:
            if self.prev_scan_energy is not None:
                expected = (
                    self.prev_scan_energy
                    - self.damage_dealt_since_scan
                    + self.energy_given_since_scan
                )
                drop = expected - ev.scanned_energy
                if 0.09 <= drop <= 3.01:
                    self.incoming = IncomingBullet(
                        origin_x=self.enemy_x,
                        origin_y=self.enemy_y,
                        speed=calc_bullet_speed(drop),
                        power=drop,
                        fired_turn=self.prev_scan_turn,
                    )
                    self.enemy_fired_recently = 1.0
            self.enemy_known = True
            self.enemy_x = ev.scanned_x
            self.enemy_y = ev.scanned_y
            self.enemy_direction = ev.scanned_direction
            self.enemy_speed = ev.scanned_speed
            self.prev_scan_energy = ev.scanned_energy
            self.enemy_energy = ev.scanned_energy
            self.prev_scan_turn = self.turn
            self.last_scan_turn = self.turn
            self.damage_dealt_since_scan = 0.0
            self.energy_given_since_scan = 0.0
        elif self.enemy_known:
            a = math.radians(self.enemy_direction)
            self.enemy_x = clamp(
                self.enemy_x + math.cos(a) * self.enemy_speed,
                BOT_RADIUS, ARENA_WIDTH - BOT_RADIUS,
            )
            self.enemy_y = clamp(
                self.enemy_y + math.sin(a) * self.enemy_speed,
                BOT_RADIUS, ARENA_HEIGHT - BOT_RADIUS,
            )

        self.enemy_fired_recently *= 0.9
        if self.incoming is not None:
            b = self.incoming
            dist_to_me = math.hypot(me.x - b.origin_x, me.y - b.origin_y)
            traveled = b.speed * (self.turn - b.fired_turn)
            if traveled > dist_to_me + 60:
                self.incoming = None

    def auto_intents(self, me: MyState):
        staleness = self.turn - self.last_scan_turn
        if not self.enemy_known or staleness > SCAN_STALE_LIMIT:
            radar_rate = MAX_RADAR_TURN_RATE
        else:
            rb = self._bearing_from(me.x, me.y, me.radar_direction, self.enemy_x, self.enemy_y)
            radar_rate = clamp(2.0 * rb, -MAX_RADAR_TURN_RATE, MAX_RADAR_TURN_RATE)

        aim_x, aim_y = self.aim_point(me)
        gb = self._bearing_from(me.x, me.y, me.gun_direction, aim_x, aim_y)
        gun_rate = clamp(gb, -MAX_GUN_TURN_RATE, MAX_GUN_TURN_RATE)
        return gun_rate, radar_rate, False

    def aim_point(self, me: MyState):
        if not self.enemy_known:
            return self.enemy_x, self.enemy_y
        distance = math.hypot(self.enemy_x - me.x, self.enemy_y - me.y)
        power = self._auto_power(distance)
        bullet_speed = calc_bullet_speed(power)
        t = distance / bullet_speed
        a = math.radians(self.enemy_direction)
        lead_x = self.enemy_x + math.cos(a) * self.enemy_speed * t * GUN_LEAD
        lead_y = self.enemy_y + math.sin(a) * self.enemy_speed * t * GUN_LEAD
        lead_x = clamp(lead_x, BOT_RADIUS, ARENA_WIDTH - BOT_RADIUS)
        lead_y = clamp(lead_y, BOT_RADIUS, ARENA_HEIGHT - BOT_RADIUS)
        return lead_x, lead_y

    @staticmethod
    def _auto_power(distance: float) -> float:
        return min(3.0, max(0.5, 500.0 / max(distance, 1.0)))

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
    """Returns (decide_fn: obs -> action int, config dict).

    Local override for testing: NDRIGGS_MODEL_PATH (+ NDRIGGS_OBS_MODE).
    Otherwise downloads config + weights from HuggingFace (cached after first boot).
    """
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
            gun_heat=bs.gun_heat,
        )

        ev = TickEvents()
        for event in e.events:
            if isinstance(event, ScannedBotEvent):
                ev.scanned_x = event.x
                ev.scanned_y = event.y
                ev.scanned_direction = event.direction
                ev.scanned_speed = event.speed
                ev.scanned_energy = event.energy
            elif isinstance(event, HitByBulletEvent):
                ev.hit_by_bullets.append(
                    (event.bullet.power, event.bullet.direction, event.damage)
                )
            elif isinstance(event, BulletHitBotEvent):
                ev.my_bullet_hits.append((event.bullet.power, event.damage))
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
        if self.firepower_cmd > 0:
            self.set_fire(self.firepower_cmd)


if __name__ == "__main__":
    NdriggsBot().start()
