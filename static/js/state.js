/**
 * @fileoverview Centralized application state.
 *
 * All mutable state shared across modules lives here as properties of the
 * `state` object. Modules import `state` and read / mutate its fields rather
 * than relying on module-scoped globals — this keeps the data flow explicit
 * and makes it trivial to inspect application state from the dev console.
 *
 * Conventions:
 *   - `historyMain`         : main line of the loaded PGN (or empty if none).
 *   - `historyVariations`   : moves played after the user deviated from main.
 *   - `pgn_moves` / `pgn_fens` are kept aligned: `pgn_fens[i]` is the FEN
 *     *before* `pgn_moves[i]` was played; `pgn_fens[pgn_moves.length]` is the
 *     FEN of the final position.
 *   - `currentMainlineIndex` is 1-based at the cursor (0 means "before move 1").
 *   - `currentVariationIndex` is -1 when not in a deviation, otherwise 1-based
 *     within `historyVariations`.
 */

/** Default FEN string for the starting position of a chess game. */
export const STARTING_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * Live application state. Mutated in place by the various modules.
 * @type {{
 *   whitePlayer: string,
 *   blackPlayer: string,
 *   gameResult: string,
 *   currentOpeningName: string,
 *   is_moving: boolean,
 *   board: object|null,
 *   game_fen: string,
 *   historyMain: Array<Object>,
 *   historyVariations: Array<Object>,
 *   pgn_moves: Array<Object>,
 *   pgn_fens: Array<string>,
 *   pgn_index: number,
 *   in_deviation: boolean,
 *   topMovesCache: Array<Object>,
 *   cachedOpenings: Object,
 *   currentMainlineIndex: number,
 *   currentVariationIndex: number,
 *   deviationStartIndex: number,
 *   evalHistory: Array<number>,
 *   evalChart: object|null,
 * }}
 */
export const state = {
  whitePlayer: "",
  blackPlayer: "",
  gameResult: "",
  currentOpeningName: "Starting Position",
  is_moving: false,
  board: null,
  game_fen: STARTING_FEN,
  historyMain: [],
  historyVariations: [],
  pgn_moves: [],
  pgn_fens: [],
  pgn_index: 0,
  in_deviation: false,
  topMovesCache: [],
  cachedOpenings: {},
  currentMainlineIndex: 0,
  currentVariationIndex: -1,
  deviationStartIndex: 0,
  evalHistory: [],
  evalChart: null,
};
