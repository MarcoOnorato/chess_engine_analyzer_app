"""
Analysis math + aggregation for the Player DB, ported 1:1 from the client-side
game-review pipeline so a stored game's numbers match what the Review page shows
for the same game at the same depth.

Sources of truth (keep in sync):
  - move accuracy curve         -> static/js/accuracy.js  (moveAccuracy)
  - ACPL -> estimated Elo curve  -> static/js/game-review.js (estimateElo, ELO_CURVE)
  - phase detection thresholds   -> static/js/game-review.js
"""

import math
from typing import Any, Dict, List, Optional

from . import db

# --- constants mirrored from the JS ---------------------------------------

# accuracy.js: 100 * exp(-0.0055 * cpLoss), clamped to [0, 100]
_ACCURACY_DECAY = 0.0055

# game-review.js ELO_CURVE (acpl, elo) control points, piecewise linear.
ELO_CURVE = [
    (0, 2900), (5, 2700), (10, 2500), (15, 2300), (20, 2100),
    (30, 1900), (40, 1700), (50, 1500), (60, 1300), (80, 1100),
    (100, 900), (150, 650), (250, 450),
]

# game-review.js phase thresholds.
MIN_OPENING_PLY = 20
OPENING_PLY_CAP = 40
ENDGAME_MATERIAL_THRESHOLD = 20
MATERIAL_WEIGHTS = {"q": 9, "r": 5, "b": 3, "n": 3}

PHASES = ["opening", "middlegame", "endgame"]


def move_accuracy(cp_loss: Optional[float]) -> Optional[float]:
    """accuracy.js::moveAccuracy — cp loss (centipawns) to accuracy in [0, 100]."""
    if cp_loss is None:
        return None
    return max(0.0, min(100.0, 100.0 * math.exp(-_ACCURACY_DECAY * cp_loss)))


def estimate_elo(acpl: Optional[float]) -> Optional[int]:
    """game-review.js::estimateElo — piecewise-linear ACPL -> rough Elo."""
    if acpl is None or math.isnan(acpl):
        return None
    if acpl <= ELO_CURVE[0][0]:
        return ELO_CURVE[0][1]
    for i in range(1, len(ELO_CURVE)):
        x1, y1 = ELO_CURVE[i - 1]
        x2, y2 = ELO_CURVE[i]
        if acpl <= x2:
            t = (acpl - x1) / (x2 - x1)
            return round(y1 + t * (y2 - y1))
    return ELO_CURVE[-1][1]


def material_phase_score(fen: str) -> int:
    """game-review.js::materialPhaseScore — sum of non-pawn piece weights."""
    placement = fen.split(" ")[0]
    score = 0
    for ch in placement:
        w = MATERIAL_WEIGHTS.get(ch.lower())
        if w:
            score += w
    return score


def assign_phases(moves: List[Dict[str, Any]]) -> None:
    """
    Tags each main-line move dict with a `phase`, replicating the two-pass logic
    of game-review.js::computeGameReview. `moves` must be ordered by ply and each
    carry `ply`, `opening`, `fen_after`. Mutates the dicts in place.
    """
    # Pass 1: how far genuine book recognition extends (within the cap).
    opening_end_ply = MIN_OPENING_PLY
    for m in moves:
        if m["ply"] > OPENING_PLY_CAP:
            continue
        op = m.get("opening")
        is_book = op and op not in ("Custom Position", "Starting Position")
        if is_book:
            opening_end_ply = max(opening_end_ply, m["ply"])

    # Pass 2: monotonic phase — once endgame, never back.
    in_endgame = False
    for m in moves:
        if material_phase_score(m["fen_after"]) <= ENDGAME_MATERIAL_THRESHOLD:
            in_endgame = True
        if in_endgame:
            m["phase"] = "endgame"
        elif m["ply"] <= opening_end_ply:
            m["phase"] = "opening"
        else:
            m["phase"] = "middlegame"


def game_opening_name(moves: List[Dict[str, Any]]) -> str:
    """Deepest recognized book opening on the main line (like currentOpeningName)."""
    name = "Starting Position"
    for m in moves:
        if m["ply"] > OPENING_PLY_CAP:
            break
        op = m.get("opening")
        if op and op not in ("Custom Position", "Starting Position"):
            name = op
    return name


def aggregate_game(
    moves: List[Dict[str, Any]],
    player_color: str,
    depth: int,
) -> Dict[str, Any]:
    """
    Per-game summary from the tracked player's perspective. `moves` are the
    main-line move dicts (with cp_loss, label, phase, opening) already tagged by
    assign_phases. Aggregates only the tracked side's moves.
    """
    cp_losses: List[float] = []
    accuracies: List[float] = []
    label_counts: Dict[str, int] = {}

    for m in moves:
        if m["side"] != player_color:
            continue
        cp = m.get("cp_loss")
        if cp is not None:
            cp_losses.append(cp)
            acc = move_accuracy(cp)
            if acc is not None:
                accuracies.append(acc)
        label = m.get("label")
        if label:
            label_counts[label] = label_counts.get(label, 0) + 1

    acpl = sum(cp_losses) / len(cp_losses) if cp_losses else None
    accuracy = sum(accuracies) / len(accuracies) if accuracies else None

    return {
        "accuracy": round(accuracy, 2) if accuracy is not None else None,
        "acpl": round(acpl, 2) if acpl is not None else None,
        "est_elo": estimate_elo(acpl),
        "moves_count": len(cp_losses),
        "label_counts": label_counts,
        "opening": game_opening_name(moves),
        "analysis_depth": depth,
    }


# --- dashboard aggregation -------------------------------------------------

def _winrate_bucket() -> Dict[str, int]:
    return {"win": 0, "loss": 0, "draw": 0}


# Preferred display order for time controls; unknown values are appended, sorted.
TIME_CLASS_ORDER = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "daily", "correspondence"]


def _summarize(games: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Win/draw/loss counts + move-weighted accuracy/acpl/est_elo for a game set."""
    wdl = _winrate_bucket()
    acc_sum = acc_w = acpl_sum = acpl_w = 0.0
    for g in games:
        res = g.get("player_result")
        if res in wdl:
            wdl[res] += 1
        n = g.get("moves_count") or 0
        if g.get("accuracy") is not None and n:
            acc_sum += g["accuracy"] * n
            acc_w += n
        if g.get("acpl") is not None and n:
            acpl_sum += g["acpl"] * n
            acpl_w += n
    total = len(games)
    avg_accuracy = round(acc_sum / acc_w, 1) if acc_w else None
    avg_acpl = round(acpl_sum / acpl_w, 1) if acpl_w else None
    return {
        "games": total,
        **wdl,
        "winrate": round(100.0 * wdl["win"] / total, 1) if total else None,
        "avg_accuracy": avg_accuracy,
        "avg_acpl": avg_acpl,
        "est_elo": estimate_elo(avg_acpl) if avg_acpl is not None else None,
    }


def _time_class_order_key(tc: str) -> tuple:
    return (TIME_CLASS_ORDER.index(tc), "") if tc in TIME_CLASS_ORDER else (len(TIME_CLASS_ORDER), tc)


def build_dashboard(profile_id: int, time_class: Optional[str] = None) -> Dict[str, Any]:
    """
    Aggregates a profile's games into the dashboard payload. KPIs/charts reflect
    the selected `time_class` (None = all); the `time_controls` breakdown is
    always computed over every game so the filter/grouping stays stable.
    """
    all_games = db.games_for_profile(profile_id)

    # --- grouping: per time-control summary over ALL games ---
    tc_groups: Dict[str, List[Dict[str, Any]]] = {}
    for g in all_games:
        tc = g.get("time_class") or "unknown"
        tc_groups.setdefault(tc, []).append(g)
    time_controls = [
        {"time_class": tc, **_summarize(gs)}
        for tc, gs in sorted(tc_groups.items(), key=lambda kv: _time_class_order_key(kv[0]))
    ]

    # --- filtered subset for KPIs/charts ---
    games = [g for g in all_games if (g.get("time_class") or "unknown") == time_class] if time_class else all_games

    summary = _summarize(games)
    by_color = {"white": _winrate_bucket(), "black": _winrate_bucket()}
    openings: Dict[str, Dict[str, Any]] = {}
    label_totals: Dict[str, int] = {}
    trend: List[Dict[str, Any]] = []

    for g in games:
        res = g.get("player_result")
        color = g.get("player_color")
        if color in by_color and res in by_color[color]:
            by_color[color][res] += 1

        op = g.get("opening") or "Unknown"
        ob = openings.setdefault(op, {"opening": op, "games": 0, **_winrate_bucket()})
        ob["games"] += 1
        if res in ("win", "loss", "draw"):
            ob[res] += 1

        for label, col in db._LABEL_COL.items():
            label_totals[label] = label_totals.get(label, 0) + int(g.get(col) or 0)

        if g.get("accuracy") is not None:
            trend.append({
                "game_id": g["id"],
                "played_at": g.get("played_at"),
                "accuracy": g["accuracy"],
                "est_elo": g.get("est_elo"),
                "result": res,
                "opening": op,
            })

    # per-phase accuracy from stored per-move cp_loss (tracked side only), filtered
    phase_rows = db.phase_accuracy_rows(profile_id, time_class)
    phase_map = {r["phase"]: r for r in phase_rows if r.get("phase")}
    phases = []
    for ph in PHASES:
        r = phase_map.get(ph)
        if r and r.get("avg_cp_loss") is not None:
            acc = move_accuracy(r["avg_cp_loss"])
            phases.append({
                "phase": ph,
                "accuracy": round(acc, 1) if acc is not None else None,
                "est_elo": estimate_elo(r["avg_cp_loss"]),
                "moves": r.get("n", 0),
            })
        else:
            phases.append({"phase": ph, "accuracy": None, "est_elo": None, "moves": 0})

    trend.sort(key=lambda t: (t.get("played_at") or ""))
    openings_list = sorted(openings.values(), key=lambda o: o["games"], reverse=True)
    overall = {"win": summary["win"], "draw": summary["draw"], "loss": summary["loss"]}

    return {
        "time_class": time_class,
        "time_controls": time_controls,
        "kpis": {
            "games": summary["games"],
            "avg_accuracy": summary["avg_accuracy"],
            "avg_acpl": summary["avg_acpl"],
            "est_elo": summary["est_elo"],
            "brilliant": label_totals.get("Brilliant", 0),
            "wins": overall["win"],
            "losses": overall["loss"],
            "draws": overall["draw"],
            "winrate": summary["winrate"],
        },
        "winrate": {"overall": overall, "by_color": by_color},
        "openings": openings_list,
        "trend": trend,
        "phases": phases,
        "move_quality": label_totals,
    }
