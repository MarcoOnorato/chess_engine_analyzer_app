"""
Chess Analysis App - Flask Backend.

Serves a chessboard.js frontend and communicates with the Stockfish engine
to analyze chess positions and validate moves.
"""

import atexit
import io
import json
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import chess
import chess.engine
import chess.pgn
from flask import Flask, Response, jsonify, render_template, request
from flask.typing import ResponseReturnValue

app = Flask(__name__)

# --- CONFIG ---------------------------------------------------------------

# Using os.getenv to retrieve the environment variable, but wrapping it in pathlib.Path
STOCKFISH_PATH: Path = Path(os.getenv(
    "STOCKFISH_PATH",
    r"windows_stockfish\stockfish-windows-x86-64-avx2.exe"
))

PIECE_VALUES: Dict[int, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0
}

OPENINGS_MAP: Dict[str, List[str]] = {}
INVALID_OPENINGS: Dict[str, List[Dict[str, str]]] = {}


def is_real_sacrifice(board: chess.Board, move: chess.Move) -> bool:
    moving_piece = board.piece_at(move.from_square)
    if not moving_piece:
        return False

    my_value = PIECE_VALUES.get(moving_piece.piece_type, 0)
    captured_piece = board.piece_at(move.to_square)
    captured_value = PIECE_VALUES.get(captured_piece.piece_type, 0) if captured_piece else 0

    board.push(move)

    if board.is_checkmate():
        board.pop()
        return False

    moved_square = move.to_square
    opponent_color = board.turn
    my_color = not opponent_color

    legal_enemy_attackers = []

    for attacker_sq in board.attackers(opponent_color, moved_square):
        test_move = chess.Move(attacker_sq, moved_square)
        if test_move in board.legal_moves:
            legal_enemy_attackers.append(attacker_sq)

    attacked_legally = len(legal_enemy_attackers) > 0
    defended_by_me = board.is_attacked_by(my_color, moved_square)

    result = False

    if attacked_legally and my_value > captured_value:
        if not defended_by_me:
            result = True
        else:
            cheapest_attacker = min(
                PIECE_VALUES[board.piece_at(sq).piece_type]  # type: ignore
                for sq in legal_enemy_attackers
                if board.piece_at(sq)
            )
            if cheapest_attacker < my_value:
                result = True

    board.pop()
    return result


def load_openings_database() -> None:
    """
    Loads the chess openings database from a JSON file into memory.
    Validates sequences and populates OPENINGS_MAP and INVALID_OPENINGS.
    """
    global OPENINGS_MAP, INVALID_OPENINGS
    
    # Safely handle the static folder path
    static_folder: str = app.static_folder if app.static_folder else "static"
    path: Path = Path(static_folder) / "openings.json"

    try:
        with path.open("r", encoding="utf-8") as f:
            data: Dict[str, Union[str, List[str]]] = json.load(f)

        for opening_name, sequences in data.items():
            if isinstance(sequences, str):
                sequences = [sequences]

            for seq in sequences:
                board = chess.Board()
                tokens: List[str] = seq.replace("\n", " ").split()
                san_moves: List[str] = [
                    t for t in tokens 
                    if not t.endswith(".") and not t.replace(".", "").isdigit()
                ]

                try:
                    for san in san_moves:
                        board.push_san(san)

                    # Store the first 3 parts of the FEN (pieces, active color, castling)
                    fen_key: str = " ".join(board.fen().split()[:3])

                    if fen_key not in OPENINGS_MAP:
                        OPENINGS_MAP[fen_key] = []

                    if opening_name not in OPENINGS_MAP[fen_key]:
                        OPENINGS_MAP[fen_key].append(opening_name)

                except Exception as e:
                    INVALID_OPENINGS.setdefault(opening_name, []).append({
                        "sequence": seq,
                        "error": str(e)
                    })

        print(f"Loaded openings: {len(OPENINGS_MAP)} positions")
        print(f"Invalid openings: {len(INVALID_OPENINGS)} entries")

        if INVALID_OPENINGS:
            print("\n❌ INVALID OPENINGS DETECTED:")
            for k, v in INVALID_OPENINGS.items():
                print(f"- {k}: {len(v)} error(s)")
                for err in v:
                    print(f"   -> {err['error']}")

    except Exception as e:
        print(f"Error loading openings database: {e}")


# Initialize the database on startup
with app.app_context():
    load_openings_database()


# --- SINGLE ENGINE + ANALYSIS CACHE --------------------------------------
#
# One engine instance runs sequentially.  The result of analysing position N
# is stored in _last_analysis so that when the frontend asks for position N+1
# (passing prev_fen == FEN of N) we can skip re-analysing the previous
# position entirely and reuse the cached data.
#
# Cache entry shape:
#   { "fen": str, "depth": int, "info": List[engine.InfoDict] }
#
# The cache is intentionally NOT thread-safe with locks because Flask's
# development server is single-threaded; for production (gunicorn) use a
# single worker or add a threading.Lock around reads/writes.

import threading

_engine: Optional[chess.engine.SimpleEngine] = None
_engine_lock = threading.Lock()
_last_analysis: Dict[str, Any] = {}   # keys: fen, depth, info


def _create_engine() -> chess.engine.SimpleEngine:
    engine = chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH))
    engine.configure({"Threads": max(1, (os.cpu_count() or 2) - 1)})
    return engine


def init_engine() -> None:
    global _engine
    _engine = _create_engine()


def get_engine() -> chess.engine.SimpleEngine:
    """Returns the single shared engine instance (caller must hold _engine_lock)."""
    global _engine
    if _engine is None:
        _engine = _create_engine()
    return _engine


@atexit.register
def _close_engine() -> None:
    global _engine
    if _engine is not None:
        try:
            _engine.quit()
        except Exception:
            pass
        _engine = None


# init engine at startup
with app.app_context():
    init_engine()


# --- MOVE CLASSIFICATION --------------------------------------------------

def classify_move(score_diff: float, is_sacrifice: bool = False) -> Tuple[str, str, str]:
    """
    Classifies a move based on the engine score difference and sacrifice status.

    Args:
        score_diff (float): Centipawn evaluation drop after the move.
        is_sacrifice (bool, optional): Whether the move is a real sacrifice. Defaults to False.

    Returns:
        Tuple[str, str, str]: The label, symbol, and hex color code for the UI.
    """
    if is_sacrifice and score_diff < 20:  # TODO: aggiungere che se sto in linea di matto lo score potrebbe essere None settarlo tipo ad ASSAI per non far tipo da M4 a 10 perchè ho appeso un pezzo e mi dice geniale
        return "Brilliant", "!!", "#15a2b8"
    if score_diff <= 5:
        return "Best", "★", "#26bbff"
    if score_diff < 30:
        return "Excellent", "++", "#96bc4b"
    if score_diff < 80:
        return "Good", "+", "#96bc4b"
    if score_diff < 150:
        return "Inaccuracy", "?!", "#f0c15c"
    if score_diff < 300:
        return "Mistake", "?", "#e6912c"
    return "Blunder", "??", "#b33430"


def score_to_float(score_obj: chess.engine.PovScore, pov_white: bool = True) -> float:
    """
    Converts an engine PovScore object into a float value representing pawns.

    Args:
        score_obj (chess.engine.PovScore): The score object returned by the engine.
        pov_white (bool, optional): If True, returns score from White's POV. Defaults to True.

    Returns:
        float: The evaluation in pawns.
    """
    if pov_white:
        cp = score_obj.white().score(mate_score=10000)
    else:
        cp = score_obj.relative.score(mate_score=10000)
        
    return cp / 100.0 if cp is not None else 0.0


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


def sort_opening_dict(openings: Dict[str, List[str]]) -> OrderedDict[str, List[str]]:
    """
    Sorts the openings dictionary for deterministic querying.

    Args:
        openings (Dict[str, List[str]]): The unordered openings map.

    Returns:
        OrderedDict[str, List[str]]: Openings sorted by sequence length, then alphabetically.
    """
    return OrderedDict(
        sorted(
            openings.items(),
            key=lambda item: (
                len(item[1][0]),   # First line length
                item[0].lower()    # Alphabetical order
            )
        )
    )

SORTED_OPENINGS_MAP: OrderedDict[str, List[str]] = sort_opening_dict(OPENINGS_MAP)


def get_best_opening_name(fen: str) -> str:
    """
    Matches a given FEN string to the most relevant opening name.

    Args:
        fen (str): The FEN string to check.

    Returns:
        str: The matched opening name, or "Custom Position" / "Starting Position".
    """
    parts: List[str] = fen.split()
    fen_key_3: str = " ".join(parts[:3])
    fen_key_2: str = " ".join(parts[:2])

    names: List[str] = SORTED_OPENINGS_MAP.get(fen_key_3) or SORTED_OPENINGS_MAP.get(fen_key_2) or []
    
    if not names:
        return "Custom Position"

    filtered_names: List[str] = [n for n in names if n.lower() != "Starting Position"]
    
    if not filtered_names:
        return "Starting Position"

    filtered_names.sort()
    return filtered_names[0]


def extract_top_moves(info_list: List[Any], board: chess.Board) -> List[Dict[str, Any]]:
    moves: List[Dict[str, Any]] = []
    for entry in info_list:
        if "pv" not in entry or not entry["pv"]:
            continue
            
        move: chess.Move = entry["pv"][0]
        score: chess.engine.Score = entry["score"].white()

        uci_str = move.uci()

        pv_moves = entry.get("pv", [])
        continuation_san = []
        temp_board = board.copy()
        for pv_move in pv_moves[:10]: 
            continuation_san.append(temp_board.san(pv_move))
            temp_board.push(pv_move)

        cp = 0.0
        if score.is_mate():
            mate_moves = score.mate()
            moves.append({
                "uci": uci_str,
                "san": board.san(move),
                "from": uci_str[:2],
                "to": uci_str[2:4],
                "score": None,
                "mate": mate_moves,
                "continuation": " ".join(continuation_san)
            })
            continue
        else:
            engine_score = score.score()
            if engine_score is not None:
                cp = engine_score / 100

        moves.append({
            "uci": uci_str,
            "san": board.san(move),
            "from": uci_str[:2],
            "to": uci_str[2:4],
            "score": cp,
            "mate": None,
            "continuation": " ".join(continuation_san)
        })
    return moves


@app.route("/api/analyze", methods=["POST"])
def analyze() -> Response:
    data: Dict[str, Any] = request.get_json(force=True)

    fen: str = data.get("fen", "")
    depth: int = int(data.get("depth", 14))
    prev_fen: Optional[str] = data.get("prev_fen")
    last_move_uci: Optional[str] = data.get("last_move_uci")

    board = chess.Board(fen)
    detected_opening = get_best_opening_name(fen)

    if board.fullmove_number <= 1 and detected_opening.lower() == "Custom Position":
        detected_opening = "Starting Position"

    limit = chess.engine.Limit(depth=depth)

    # --- SINGLE ENGINE, SEQUENTIAL + CACHE ---
    # If the caller provides prev_fen and we have a cached analysis for it
    # at the same (or higher) depth, we skip re-analysing the previous
    # position entirely.  Then we analyse the current position and store
    # the result for the *next* request.
    with _engine_lock:
        engine = get_engine()

        # Resolve previous-position analysis from cache or fresh engine call.
        prev_info_list: Optional[List[Any]] = None
        if prev_fen:
            cached = _last_analysis
            if (
                cached.get("fen") == prev_fen
                and cached.get("depth", 0) >= depth
            ):
                prev_info_list = cached["info"]
            else:
                prev_board = chess.Board(prev_fen)
                prev_info_list = engine.analyse(prev_board, limit, multipv=3)

        # Analyse current position.
        info_list = engine.analyse(board, limit, multipv=3)

    # Cache the current analysis for the next request.
    _last_analysis.clear()
    _last_analysis.update({"fen": fen, "depth": depth, "info": info_list})

    # --- CURRENT POSITION ---
    top_moves = extract_top_moves(info_list, board)
    top = top_moves[0] if top_moves else None

    if top:
        if top.get("mate") is not None:
            mate_val = top["mate"]
            eval_score = 100.0 if mate_val > 0 else -100.0
            eval_mate = mate_val
        else:
            eval_score = top["score"]
            eval_mate = None
    else:
        eval_score = 0.0
        eval_mate = None

    classification = None
    alternative_moves = []

    # --- PREVIOUS POSITION ---
    if prev_fen and last_move_uci and prev_info_list:
        try:
            prev_board = chess.Board(prev_fen)
            last_move = chess.Move.from_uci(last_move_uci)

            alternative_moves = extract_top_moves(prev_info_list, prev_board)

            prev_best_score = prev_info_list[0]["score"]
            curr_score = info_list[0]["score"] if info_list else None

            # If there is a mate line
            # If the current move is part of the mate line
            post_board = prev_board.copy(stack=False)
            post_board.push(last_move)
            played_is_mate = post_board.is_checkmate()

            # If prev move was in the mate line
            prev_best_is_mate = prev_best_score.relative.is_mate()

            # If current move is still a mate line
            curr_is_mate = (curr_score is not None and curr_score.relative.is_mate())

            played_san = prev_board.san(last_move)

            # Checkmate is always the best move
            if played_is_mate:
                label, symbol, color = "Best", "★", "#26bbff"
                diff = 0.0

                # Assegna il matto in modo assoluto: +1 se vince il Bianco, -1 se vince il Nero
                eval_mate = 1 if prev_board.turn == chess.WHITE else -1
                eval_score = 100.0 if eval_mate > 0 else -100.0

            # If SAN explicitly ends in mate (#)
            elif prev_best_is_mate and played_san.endswith("#"):
                # Usa .white() invece di .relative() per mantenere il segno corretto
                mate_val = prev_best_score.white().mate()

                eval_mate = mate_val
                eval_score = 100.0 if (mate_val or 0) > 0 else -100.0

            # If current move is a mate line but longer it will never be error or blunder
            elif curr_is_mate and prev_best_is_mate:
                prev_mate_dist = abs(prev_best_score.relative.mate() or 0)
                curr_mate_dist = abs(curr_score.relative.mate() or 0)  # type: ignore
                mate_delay = max(0, curr_mate_dist - prev_mate_dist)
                diff = min(mate_delay * 30.0, 149.0)

                is_sac = is_real_sacrifice(prev_board, last_move)
                label, symbol, color = classify_move(diff, is_sac)
            else:
                # Normal line
                MATE_CP = 10000
                best_eval_prev = prev_best_score.relative.score(mate_score=MATE_CP) or 0
                if curr_score is not None:
                    actual_eval_raw = curr_score.relative.score(mate_score=MATE_CP)
                    actual_eval = -(actual_eval_raw or 0)
                else:
                    actual_eval = 0

                raw_loss = float(best_eval_prev - actual_eval)
                diff = max(0.0, raw_loss)
                is_sac = is_real_sacrifice(prev_board, last_move)
                label, symbol, color = classify_move(diff, is_sac)

            classification = {
                "label": label,
                "symbol": symbol,
                "color": color,
                "diff_cp": diff,
            }

        except Exception as e:
            classification = {"error": str(e)}

    result = None

    if board.is_game_over():
        outcome = board.outcome()
        if outcome:
            result = outcome.result()  # "1-0", "0-1", "1/2-1/2"

    return jsonify({
        "fen": fen,
        "eval": eval_score,
        "eval_mate": eval_mate,
        "top_moves": top_moves,
        "alternative_moves": alternative_moves,
        "classification": classification,
        "best_eval_loss": classification["diff_cp"] if classification else 0,
        "opening": detected_opening,
        "turn": "white" if board.turn else "black",
        "is_game_over": board.is_game_over(),
        "legal_moves": [m.uci() for m in board.legal_moves],
        "result": result,
    })


@app.route("/api/legal_moves", methods=["POST"])
def legal_moves() -> Response:
    """
    Performs a quick legality check for a single move.
    Primarily used by chessboard.js during the 'onDrop' event.

    Expected JSON Body:
        fen (str): Current board position.
        from (str): Starting square.
        to (str): Target square.
        promotion (str, optional): Promotion piece type (default: "q").

    Returns:
        Response: JSON payload indicating if the move is legal and the resulting state.
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

    `pgn_node` here is a non-root node — it has a `move` and a `parent`.
    `parent_board` is a chess.Board representing the position *before* this
    node's move (== the parent node's `fenAfter`). We never mutate it; we
    derive a child board with `parent_board.copy()` + push.

    NAGs are emitted as a list of integers (the standard PGN $-codes); the
    frontend can either ignore them or render them as glyphs (!?, ?, !!, …).

    Args:
        pgn_node: The current node (must have a `move`).
        parent_board: Position before `pgn_node.move`.

    Returns:
        Dict[str, Any]: The serialized subtree.
    """
    move = pgn_node.move
    assert move is not None
    san = parent_board.san(move)
    uci = move.uci()

    fen_before = parent_board.fen()
    child_board = parent_board.copy(stack=False)
    child_board.push(move)
    fen_after = child_board.fen()

    # python-chess exposes `pgn_node.variations`: variations[0] is the main
    # continuation, variations[1:] are sidelines. We mirror that order in
    # `children`, so children[0] is the continuation chosen as main line.
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
    older frontends. Kept for backwards compatibility — new frontends should
    use the `tree` field instead.

    Returns:
        Tuple of (moves, fens) where:
            - moves[i] = {"uci": ..., "san": ...} for the i-th main-line ply
            - fens[i]  = FEN before moves[i]; fens[-1] = FEN after the last move
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

    Expected JSON Body:
        pgn (str): The raw PGN text.

    Returns:
        ResponseReturnValue: JSON payload with the following shape:

        {
            "start_fen": str,                  // FEN before move 1 (root.fenAfter)
            "headers":   { ... PGN headers },
            "tree": {                          // root of the game tree
                "fenAfter": <start_fen>,
                "comment":  str,               // game start comment, if any
                "children": [Node, ...]        // children[0] = main-line move 1
            },
            // --- Legacy fields (main line only) ---
            "moves": [{uci, san}, ...],
            "fens":  [fen_before_move_1, ..., fen_after_last_move],
        }

        Each Node (recursively):
        {
            "san":       str,
            "uci":       str,
            "fenBefore": str,
            "fenAfter":  str,
            "comment":   str,
            "nags":      [int, ...],
            "children":  [Node, ...]
        }
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

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
