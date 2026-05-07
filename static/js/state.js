/**
 * @fileoverview Centralized application state — game-tree edition.
 *
 * The position history is modelled as a tree of `Node` objects, similar to
 * Chess.com / Lichess. Every position is a node; its children are the moves
 * that have been played from it. The first child is, by convention, the
 * "main line" continuation; subsequent children are variations.
 *
 *   root (starting position, no move)
 *    └── e4    ← main line, child[0]
 *         ├── e5    ← main line, child[0]
 *         │    ├── Nf3   (main line)
 *         │    └── Nc3   (variation)  ← parent.children[1]
 *         └── c5    ← variation, child[1]
 *              └── Nf3   (continues the variation)
 *
 * `currentNode` is the cursor: it points at the node whose `fenAfter` is
 * displayed on the board. `state.root` represents the position *before*
 * any move (i.e. the starting position or a custom FEN), so its `fenAfter`
 * holds the initial FEN and `move` is null.
 *
 * Path concept:
 *   - The "main line" is the path obtained by always following `child[0]`.
 *   - Any other path (where at least one step picks `child[i>0]`) is a
 *     variation. We never special-case "the" deviation anymore — the tree
 *     can hold arbitrary nesting of sidelines.
 */

/** Default FEN string for the starting position of a chess game. */
export const STARTING_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/**
 * @typedef {Object} Node
 * @property {string}      id          Unique node id (monotonic counter).
 * @property {Node|null}   parent      Parent node (null only for root).
 * @property {Node[]}      children    Children. children[0] is the main line.
 * @property {string|null} san         SAN of the move that led to this node.
 * @property {string|null} uci         UCI of the move that led to this node.
 * @property {string}      fenBefore   FEN of the parent position (== parent.fenAfter).
 * @property {string}      fenAfter    FEN of the position at this node.
 * @property {number}      ply         Half-move number from the root (root = 0).
 * @property {Object|null} evalData    Engine classification (symbol/label/color).
 * @property {number|null} cpLoss      Centipawn loss vs. best move.
 * @property {number|null} eval        Static eval at this node (in pawns).
 * @property {number|null} eval_mate   Mate-in-N at this node, if any.
 */

let _nextId = 0;
/** Returns a fresh, monotonically increasing node id. */
export function nextNodeId() {
  return ++_nextId;
}

/**
 * Builds an empty root node anchored at the given FEN.
 *
 * @param {string} [fen=STARTING_FEN]
 * @returns {Node}
 */
export function makeRoot(fen = STARTING_FEN) {
  return {
    id: nextNodeId(),
    parent: null,
    children: [],
    san: null,
    uci: null,
    fenBefore: fen,
    fenAfter: fen,
    ply: 0,
    evalData: null,
    cpLoss: null,
    eval: null,
    eval_mate: null,
  };
}

/**
 * Live application state. Mutated in place by the various modules.
 *
 * Tree-related fields:
 *   - `root`         : root Node of the game tree.
 *   - `currentNode`  : Node currently displayed on the board.
 *   - `nodeIndex`    : Map<id, Node> for O(1) lookup from DOM clicks.
 *
 * @type {{
 *   whitePlayer: string,
 *   blackPlayer: string,
 *   gameResult: string,
 *   currentOpeningName: string,
 *   playersPrefix: string,
 *   is_moving: boolean,
 *   board: object|null,
 *   game_fen: string,
 *   root: Node,
 *   currentNode: Node,
 *   nodeIndex: Map<number, Node>,
 *   topMovesCache: Array<Object>,
 *   cachedOpenings: Object,
 *   evalChart: object|null,
 * }}
 */
const _root = makeRoot();
export const state = {
  whitePlayer: "",
  blackPlayer: "",
  gameResult: "",
  currentOpeningName: "Starting Position",
  playersPrefix: "",
  is_moving: false,
  board: null,
  game_fen: STARTING_FEN,

  // Game tree
  root: _root,
  currentNode: _root,
  nodeIndex: new Map([[_root.id, _root]]),

  topMovesCache: [],
  cachedOpenings: {},
  evalChart: null,
};

/* ==========================================================================
   Tree helpers
   ========================================================================== */

/**
 * Resets the tree to a fresh root anchored at the given FEN.
 * @param {string} [fen=STARTING_FEN]
 */
export function resetTree(fen = STARTING_FEN) {
  const r = makeRoot(fen);
  state.root = r;
  state.currentNode = r;
  state.nodeIndex = new Map([[r.id, r]]);
  state.game_fen = fen;
}

/**
 * Registers a node in the lookup index. Called whenever a node is created.
 * @param {Node} node
 */
export function indexNode(node) {
  state.nodeIndex.set(node.id, node);
}

/**
 * Returns the node with the given id, or undefined.
 * @param {number} id
 * @returns {Node|undefined}
 */
export function getNode(id) {
  return state.nodeIndex.get(id);
}

/**
 * Returns the path from root → node as an array of nodes (root first).
 * @param {Node} node
 * @returns {Node[]}
 */
export function pathTo(node) {
  const path = [];
  let n = node;
  while (n) {
    path.unshift(n);
    n = n.parent;
  }
  return path;
}

/**
 * The main line: array of nodes obtained by always following children[0]
 * from the root, excluding the root itself. Equivalent to the old
 * `historyMain` but computed on demand.
 * @returns {Node[]}
 */
export function mainLineNodes() {
  const out = [];
  let n = state.root;
  while (n.children.length > 0) {
    n = n.children[0];
    out.push(n);
  }
  return out;
}

/**
 * Tells whether `node` belongs to the main line (always-children[0] path).
 * Root counts as main-line.
 * @param {Node} node
 * @returns {boolean}
 */
export function isOnMainLine(node) {
  let n = node;
  while (n.parent) {
    if (n.parent.children[0] !== n) return false;
    n = n.parent;
  }
  return true;
}

/**
 * Among `parent`'s existing children, finds the one whose `uci` matches.
 * Used to auto-merge a played move with an existing variation.
 *
 * @param {Node} parent
 * @param {string} uci
 * @returns {Node|undefined}
 */
export function findChildByUci(parent, uci) {
  return parent.children.find((c) => c.uci === uci);
}
