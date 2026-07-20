"""
Analysis math + aggregation for the Player DB, ported 1:1 from the client-side
game-review pipeline so a stored game's numbers match what the Review page shows
for the same game at the same depth.

Sources of truth (keep in sync):
  - win% + accuracy model        -> static/js/accuracy.js  (winPercent, moveAccuracy)
  - accuracy -> estimated Elo     -> static/js/game-review.js (estimateElo)
  - phase detection thresholds   -> static/js/game-review.js
"""

import math
from typing import Any

from . import db

# --- win% + accuracy + Elo model (mirrored in the JS) ---------------------
#
# Accuracy is derived from *win-probability* loss, not raw centipawn loss. The
# same centipawn swing is worth a lot near equality and almost nothing in an
# already-decided position, so this is what makes "90% accuracy" mean very
# different things at 400 vs 2700: a weak player's errors happen where win% is
# volatile and get punished, so their accuracy can't inflate the way raw-cp
# accuracy did.

# Lichess win-probability logistic: centipawns (one side's POV) -> 0-100 win%.
_WIN_PCT_K = 0.00368208

# Lichess per-move accuracy from win% lost: 103.1668*exp(-0.04354*Δ)-3.1669.
_ACC_A, _ACC_B, _ACC_C = 103.1668, 0.04354, 3.1669

# Accuracy% -> estimated Elo. The relationship is strongly non-linear: win%-based
# accuracy compresses hard near 100%, so Elo rises with the reciprocal of the
# "imperfection" (100 - accuracy):
#     elo = ELO_A + ELO_B / (100 - accuracy)      (clamped to [ELO_MIN, ELO_MAX])
# A two-parameter least-squares fit to real Lichess ratings from ingested games:
# a ~1300 blitz player scores ~85%, a ~1540 rapid player ~88%, and Carlsen
# (DrNykterstein, 30 games) scores ~93.2% -> ~2800. Above ~94% it runs away, so
# the clamp caps it at a superhuman ceiling.
ELO_A, ELO_B = -90.0, 19800.0
ELO_MIN, ELO_MAX = 250, 3200

# game-review.js phase thresholds.
MIN_OPENING_PLY = 20
OPENING_PLY_CAP = 40
ENDGAME_MATERIAL_THRESHOLD = 20
MATERIAL_WEIGHTS = {"q": 9, "r": 5, "b": 3, "n": 3}

PHASES = ["opening", "middlegame", "endgame"]


def win_percent(cp: float) -> float:
    """accuracy.js::winPercent — centipawns (one side's POV) to a 0-100 win%."""
    return 100.0 / (1.0 + math.exp(-_WIN_PCT_K * cp))


def move_win_loss(eval_pawns: float | None, side: str, cp_loss: float | None) -> float | None:
    """Win% the move gave away, from the mover's POV (>= 0).

    `eval_pawns` is the stored position eval *after* the move (white's POV, in
    pawns; mates are already ±100). `cp_loss` is how much better best play was,
    in centipawns from the mover's POV — so the pre-move win% is that of the
    position `cp_loss` better than what was reached. Mirrors game-review.js.
    """
    if cp_loss is None:
        return None
    after = (eval_pawns or 0.0) * 100.0            # white's POV, centipawns
    after = after if side == "white" else -after   # mover's POV
    before = after + cp_loss                        # best play was cp_loss better
    return max(0.0, win_percent(before) - win_percent(after))


def accuracy_from_win_loss(win_loss: float | None) -> float | None:
    """accuracy.js::accuracyFromWinLoss — win% lost to a per-move accuracy [0,100]."""
    if win_loss is None:
        return None
    acc = _ACC_A * math.exp(-_ACC_B * win_loss) - _ACC_C
    return max(0.0, min(100.0, acc))


def move_accuracy(eval_pawns: float | None, side: str, cp_loss: float | None) -> float | None:
    """Context-aware per-move accuracy in [0, 100] (win%-loss based)."""
    return accuracy_from_win_loss(move_win_loss(eval_pawns, side, cp_loss))


def estimate_elo(accuracy: float | None) -> int | None:
    """game-review.js::estimateElo — win%-based accuracy% -> rough Elo via
    elo = ELO_A + ELO_B / (100 - accuracy), clamped to [ELO_MIN, ELO_MAX]."""
    if accuracy is None or math.isnan(accuracy):
        return None
    gap = 100.0 - accuracy
    if gap <= 0:
        return ELO_MAX
    return round(max(float(ELO_MIN), min(float(ELO_MAX), ELO_A + ELO_B / gap)))


def material_phase_score(fen: str) -> int:
    """game-review.js::materialPhaseScore — sum of non-pawn piece weights."""
    placement = fen.split(" ", maxsplit=1)[0]
    score = 0
    for ch in placement:
        w = MATERIAL_WEIGHTS.get(ch.lower())
        if w:
            score += w
    return score


def assign_phases(moves: list[dict[str, Any]]) -> None:
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


def game_opening_name(moves: list[dict[str, Any]]) -> str:
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
    moves: list[dict[str, Any]],
    player_color: str,
    depth: int,
) -> dict[str, Any]:
    """
    Per-game summary from the tracked player's perspective. `moves` are the
    main-line move dicts (with cp_loss, label, phase, opening) already tagged by
    assign_phases. Aggregates only the tracked side's moves.
    """
    cp_losses: list[float] = []
    accuracies: list[float] = []
    label_counts: dict[str, int] = {}

    for m in moves:
        if m["side"] != player_color:
            continue
        cp = m.get("cp_loss")
        if cp is not None:
            # Accuracy uses the full cp_loss (win% saturates on its own); ACPL
            # caps outliers so one disaster move doesn't dominate the mean.
            acc = move_accuracy(m.get("eval"), m["side"], float(cp))
            if acc is not None:
                accuracies.append(acc)
            cp_losses.append(min(float(cp), db.CP_LOSS_CAP))
        label = m.get("label")
        if label:
            label_counts[label] = label_counts.get(label, 0) + 1

    acpl = sum(cp_losses) / len(cp_losses) if cp_losses else None
    accuracy = sum(accuracies) / len(accuracies) if accuracies else None

    return {
        "accuracy": round(accuracy, 2) if accuracy is not None else None,
        "acpl": round(acpl, 2) if acpl is not None else None,
        "est_elo": estimate_elo(accuracy),
        "moves_count": len(cp_losses),
        "label_counts": label_counts,
        "opening": game_opening_name(moves),
        "analysis_depth": depth,
    }


def backfill_capped_aggregates() -> None:
    """One-time migration to the win%-based accuracy / Elo model: fills each
    move's `win_loss` and recomputes every game's capped ACPL, win%-based
    accuracy and est_elo from already-stored per-move `eval` + `cp_loss`.

    Runs without the engine — the per-move analysis is already stored — so games
    imported before this model get correct figures without re-analysis. Guarded
    by SQLite's `user_version` so it happens exactly once.
    """
    conn = db.get_conn()
    # Bump this when the accuracy / Elo model changes so stored per-game figures
    # are recomputed on next startup (v2: win%-based model; v3: reciprocal Elo
    # fit). Recompute is engine-free — it reuses stored eval + cp_loss.
    if conn.execute("PRAGMA user_version").fetchone()[0] >= 3:
        return

    for g in conn.execute("SELECT id, player_color FROM games").fetchall():
        color = g["player_color"] or "white"
        moves = db.moves_for_game(g["id"])

        # Per-move win_loss for every move (both sides) so phase aggregation works.
        for m in moves:
            if m["cp_loss"] is None:
                continue
            wl = move_win_loss(m.get("eval"), m["side"], float(m["cp_loss"]))
            conn.execute(
                "UPDATE moves SET win_loss = ? WHERE game_id = ? AND ply = ?",
                (round(wl, 4) if wl is not None else None, g["id"], m["ply"]),
            )

        tracked = [m for m in moves if m["side"] == color and m["cp_loss"] is not None]
        if not tracked:
            continue
        cps = [min(float(m["cp_loss"]), db.CP_LOSS_CAP) for m in tracked]
        acpl = sum(cps) / len(cps)
        accs = [
            a for a in (move_accuracy(m.get("eval"), m["side"], float(m["cp_loss"])) for m in tracked)
            if a is not None
        ]
        accuracy = sum(accs) / len(accs) if accs else None
        conn.execute(
            "UPDATE games SET acpl = ?, accuracy = ?, est_elo = ? WHERE id = ?",
            (
                round(acpl, 2),
                round(accuracy, 2) if accuracy is not None else None,
                estimate_elo(accuracy),
                g["id"],
            ),
        )

    conn.execute("PRAGMA user_version = 3")
    conn.commit()


# --- dashboard aggregation -------------------------------------------------

def _winrate_bucket() -> dict[str, int]:
    return {"win": 0, "loss": 0, "draw": 0}


# Preferred display order for time controls; unknown values are appended, sorted.
TIME_CLASS_ORDER = ["ultraBullet", "bullet", "blitz", "rapid", "classical", "daily", "correspondence"]


def _summarize(games: list[dict[str, Any]]) -> dict[str, Any]:
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
        "est_elo": estimate_elo(avg_accuracy) if avg_accuracy is not None else None,
    }


def _time_class_order_key(tc: str) -> tuple:
    return (TIME_CLASS_ORDER.index(tc), "") if tc in TIME_CLASS_ORDER else (len(TIME_CLASS_ORDER), tc)


def build_dashboard(profile_id: int, time_class: str | None = None) -> dict[str, Any]:
    """
    Aggregates a profile's games into the dashboard payload. KPIs/charts reflect
    the selected `time_class` (None = all); the `time_controls` breakdown is
    always computed over every game so the filter/grouping stays stable.
    """
    all_games = db.games_for_profile(profile_id)

    # --- grouping: per time-control summary over ALL games ---
    tc_groups: dict[str, list[dict[str, Any]]] = {}
    for g in all_games:
        tc = g.get("time_class") or "unknown"
        tc_groups.setdefault(tc, []).append(g)
    time_controls = [
        {"time_class": tc, **_summarize(gs)}
        for tc, gs in sorted(tc_groups.items(), key=lambda kv: _time_class_order_key(kv[0]))
    ]

    # --- filtered subset for KPIs/charts ---
    games = all_games if not time_class else [
        g for g in all_games if (g.get("time_class") or "unknown") == time_class
    ]

    summary = _summarize(games)
    by_color = {"white": _winrate_bucket(), "black": _winrate_bucket()}
    openings: dict[str, dict[str, Any]] = {}
    label_totals: dict[str, int] = {}
    trend: list[dict[str, Any]] = []

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

        for label, col in db.LABEL_COL.items():
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
        if r and r.get("avg_win_loss") is not None:
            acc = accuracy_from_win_loss(r["avg_win_loss"])
            phases.append({
                "phase": ph,
                "accuracy": round(acc, 1) if acc is not None else None,
                "est_elo": estimate_elo(acc),
                "moves": r.get("n", 0),
            })
        else:
            phases.append({"phase": ph, "accuracy": None, "est_elo": None, "moves": 0})

    # time management from stored per-move clocks (tracked side only), filtered
    tm = db.time_management_rows(profile_id, time_class)
    tm_phase_map = {r["phase"]: r for r in tm["by_phase"] if r.get("phase")}
    time_phases = []
    for ph in PHASES:
        r = tm_phase_map.get(ph)
        avg = r["avg_think"] if r and r.get("avg_think") is not None else None
        time_phases.append({
            "phase": ph,
            "avg_think": round(avg, 1) if avg is not None else None,
            "moves": int(r["n"]) if r and r.get("n") else 0,
        })
    time_management = {
        "has_clocks": tm["moves"] > 0,
        "avg_think": round(tm["avg_think"], 1) if tm["avg_think"] is not None else None,
        "moves": tm["moves"],
        "by_phase": time_phases,
        "time_trouble_seconds": tm["time_trouble_seconds"],
        "time_trouble_errors": tm["time_trouble_errors"],
    }

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
        "time_management": time_management,
    }
