"""
Chess Analysis App - Flask Backend.

Serves a chessboard.js frontend and communicates with the Stockfish engine
to analyze chess positions and validate moves.

Engine management, move classification and opening recognition live in
`analysis_core`; this module keeps only the Flask routes. The optional Player DB
feature (personal player profiles + stats dashboard) is a self-contained
Blueprint in the `player_db` package, registered only when PLAYER_DB_ENABLED.
"""

import atexit
import io
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple

import chess
import chess.pgn
from flask import Flask, Response, jsonify, render_template, request
from flask.typing import ResponseReturnValue

import analysis_core

app = Flask(__name__)


# --- FEATURE FLAG: optional Player DB --------------------------------------

def _player_db_enabled() -> bool:
    return os.getenv("PLAYER_DB_ENABLED", "1").strip().lower() not in ("0", "false", "no", "off", "")


PLAYER_DB_ENABLED: bool = _player_db_enabled()


@app.context_processor
def _inject_flags() -> Dict[str, Any]:
    """Expose feature flags to every template (e.g. the shared navbar)."""
    return {"player_db_enabled": PLAYER_DB_ENABLED}


# --- ENGINE + OPENINGS STARTUP ---------------------------------------------

with app.app_context():
    _static_folder: str = app.static_folder if app.static_folder else "static"
    analysis_core.load_openings_database(_static_folder)
    analysis_core.init_engine()


@atexit.register
def _close_engine() -> None:
    analysis_core.close_engine()


# --- ROUTES ---------------------------------------------------------------

@app.route("/")
def index() -> str:
    """Renders the main application page."""
    return render_template("index.html")


@app.route("/api/list_openings")
def list_openings() -> Response:
    """Returns the raw openings JSON dataset."""
    static_folder: str = app.static_folder if app.static_folder else "static"
    path: Path = Path(static_folder) / "openings.json"

    with path.open("r", encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/analyze", methods=["POST"])
def analyze() -> Response:
    """Analyses a position and classifies the move that led to it.

    Thin wrapper over `analysis_core.analyze_move` — the actual engine work and
    (tricky) move classification are shared with the Player DB batch ingester.
    """
    data: Dict[str, Any] = request.get_json(force=True)

    engine_elo = int(data["engine_elo"]) if data.get("engine_elo") is not None else None
    skill_level = int(data["skill_level"]) if data.get("skill_level") is not None else None

    result = analysis_core.analyze_move(
        fen=data.get("fen", ""),
        prev_fen=data.get("prev_fen"),
        last_move_uci=data.get("last_move_uci"),
        depth=int(data.get("depth", 14)),
        engine_elo=engine_elo,
        skill_level=skill_level,
    )
    return jsonify(result)


@app.route("/api/legal_moves", methods=["POST"])
def legal_moves() -> Response:
    """
    Performs a quick legality check for a single move.
    Primarily used by chessboard.js during the 'onDrop' event.
    """
    data: Dict[str, Any] = request.get_json(force=True)
    fen: str = data.get("fen", "")
    from_sq: str = data.get("from", "")
    to_sq: str = data.get("to", "")
    promotion: str = data.get("promotion", "q")

    try:
        board = chess.Board(fen)
    except ValueError:
        return jsonify({
            "legal": False,
            "error": "Invalid FEN"
        })

    move_uci: str = f"{from_sq}{to_sq}"
    try:
        move: chess.Move = chess.Move.from_uci(move_uci)
        if move not in board.legal_moves:
            # Fallback for promotion handling
            move = chess.Move.from_uci(move_uci + promotion)
    except ValueError:
        try:
            move = chess.Move.from_uci(move_uci + promotion)
        except ValueError:
            return jsonify({"legal": False})

    if move not in board.legal_moves:
        return jsonify({"legal": False})

    san: str = board.san(move)
    board.push(move)
    return jsonify({
        "legal": True,
        "san": san,
        "uci": move.uci(),
        "new_fen": board.fen(),
        "is_game_over": board.is_game_over(),
    })


def _serialize_pgn_node(
    pgn_node: chess.pgn.GameNode,
    parent_board: chess.Board,
) -> Dict[str, Any]:
    """
    Recursively serializes a python-chess `GameNode` into the JSON tree shape
    consumed by the frontend.

    The frontend's tree model is:
        Node {
            san, uci, fenBefore, fenAfter, comment, nags,
            children: [Node, ...]   // children[0] is the main line
        }
    """
    move = pgn_node.move
    assert move is not None
    san = parent_board.san(move)
    uci = move.uci()

    fen_before = parent_board.fen()
    child_board = parent_board.copy(stack=False)
    child_board.push(move)
    fen_after = child_board.fen()

    children: List[Dict[str, Any]] = [
        _serialize_pgn_node(child, child_board)
        for child in pgn_node.variations
    ]

    return {
        "san": san,
        "uci": uci,
        "fenBefore": fen_before,
        "fenAfter": fen_after,
        "comment": pgn_node.comment or "",
        "nags": sorted(pgn_node.nags),
        "children": children,
    }


def _flatten_main_line(
    game: chess.pgn.Game,
) -> Tuple[List[Dict[str, str]], List[str]]:
    """
    Returns the main-line moves and FENs as the legacy flat lists used by
    older frontends.
    """
    board = game.board()
    moves: List[Dict[str, str]] = []
    fens: List[str] = [board.fen()]

    for mv in game.mainline_moves():
        moves.append({"uci": mv.uci(), "san": board.san(mv)})
        board.push(mv)
        fens.append(board.fen())

    return moves, fens


@app.route("/api/load_pgn", methods=["POST"])
def load_pgn() -> ResponseReturnValue:
    """
    Loads and parses a PGN string into a game tree, including any sidelines
    (variations) the source PGN contains.
    """
    data: Dict[str, Any] = request.get_json(force=True)
    pgn_text: str = data.get("pgn", "").strip()

    if not pgn_text:
        return jsonify({"error": "Empty PGN"}), 400

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))

        if game is None:
            return jsonify({"error": "Invalid PGN"}), 400

        # Build the tree.
        root_board = game.board()
        tree_children: List[Dict[str, Any]] = [
            _serialize_pgn_node(child, root_board)
            for child in game.variations
        ]
        tree: Dict[str, Any] = {
            "san":       None,
            "uci":       None,
            "fenBefore": root_board.fen(),
            "fenAfter":  root_board.fen(),
            "comment":   game.comment or "",
            "nags":      [],
            "children":  tree_children,
        }

        # Backwards-compatible flat main-line representation.
        moves, fens = _flatten_main_line(game)

        if not moves and not tree_children:
            return jsonify({"error": "No valid moves found in PGN"}), 400

        return jsonify({
            "start_fen": root_board.fen(),
            "headers":   dict(game.headers),
            "tree":      tree,
            "moves":     moves,
            "fens":      fens,
        })

    except Exception as e:
        return jsonify({
            "error": f"PGN parsing failed: {str(e)}"
        }), 400


# --- OPTIONAL PLAYER DB BLUEPRINT ------------------------------------------

if PLAYER_DB_ENABLED:
    try:
        from player_db import register_player_db
        register_player_db(app)
        print("Player DB feature: ENABLED")
    except Exception as e:  # pragma: no cover - defensive: never break base app
        print(f"Player DB feature failed to initialise, continuing without it: {e}")
        PLAYER_DB_ENABLED = False
else:
    print("Player DB feature: DISABLED (set PLAYER_DB_ENABLED=1 to enable)")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
