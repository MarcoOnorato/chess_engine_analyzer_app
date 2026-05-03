// ============================================================================
// STATE VARIABLES
// ============================================================================

/** @type {string} Current name of the recognized opening */
let currentOpeningName = "Starting Position";
/** @type {boolean} Lock flag to prevent concurrent move processing */
let is_moving = false;
/** @type {object|null} Reference to the Chessboard.js instance */
let board = null;
/** @type {string} The current FEN of the game */
let game_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/** @type {Array<Object>} History array representing the main path of moves */
let historyMain = [];
/** @type {Array<Object>} History array representing deviations from the main path */
let historyVariations = [];
/** @type {Array<Object>} Array of moves loaded from a PGN file [{uci, san}] */
let pgn_moves = [];        
/** @type {Array<string>} Array of FEN strings representing each state of the loaded PGN */
let pgn_fens = [];         
/** @type {number} The current cursor index in the PGN array */
let pgn_index = 0;         
/** @type {boolean} Flag indicating whether the current board state has deviated from the PGN main line */
let in_deviation = false;
/** @type {Array<Object>} Cache of top moves suggested by the engine */
let topMovesCache = [];
/** @type {Object} Global cache for storing fetched openings data for searching */
let cachedOpenings = {};
/** @type {number} */
let currentMainlineIndex = 0;
/** @type {number} */
let currentVariationIndex = -1;
/** @type {number} */
let deviationStartIndex = 0;
let evalHistory = [];
let evalChart = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function moveAccuracy(cpLoss) {
  return Math.max(0, Math.min(100, 100 * Math.exp(-0.0045 * cpLoss)));
}

function calculateGameAccuracy() {
  let whiteScores = [];
  let blackScores = [];

  historyMain.forEach((move, i) => {
    if (move.cpLoss == null) return;

    const acc = moveAccuracy(move.cpLoss);

    if (i % 2 === 0) {
      whiteScores.push(acc);
    } else {
      blackScores.push(acc);
    }
  });

  const avg = arr =>
    arr.length
      ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1)
      : "--";

  document.getElementById("whiteAccuracy").textContent = `${avg(whiteScores)}%`;
  document.getElementById("blackAccuracy").textContent = `${avg(blackScores)}%`;
}

function renderEvalChart() {
  const ctx = document.getElementById("evalChart").getContext("2d");

  const labels = historyMain.map((_, i) => i + 1);
  const data = historyMain.map(m => {
    let val = m.eval ?? 0;
    return Math.max(-10, Math.min(10, val));
  });

  if (evalChart) {
    evalChart.destroy();
  }

  evalChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data,
        tension: 0.25,
        fill: true,
        borderColor: "#26bbff",
        backgroundColor: "rgba(38, 187, 255, 0.1)",
        pointRadius: (context) => {
          return context.dataIndex === (currentMainlineIndex - 1) ? 6 : 3;
        },
        pointBackgroundColor: (context) => {
          return context.dataIndex === (currentMainlineIndex - 1) ? "#ffffff" : "#26bbff";
        },
        pointBorderColor: (context) => {
          return context.dataIndex === (currentMainlineIndex - 1) ? "#ffffff" : "#26bbff";
        },
        pointHoverRadius: 7
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: function(evt, elements) {
        if (!elements.length) return;
        const clickedIndex = elements[0].index;
        jumpToMainLineFromChart(clickedIndex);
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: () => null,
            label: function(context) {
              const move = historyMain[context.dataIndex];
              if (!move) return "";
              return move.san; 
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#888" },
          grid: { color: "rgba(255,255,255,0.05)" }
        },
        y: {
          min: -10,
          max: 10,
          ticks: {
            color: "#888",
            callback: function(value) { return value > 0 ? `+${value}` : value; }
          },
          grid: { color: "rgba(255,255,255,0.05)" }
        }
      }
    }
  });
}

// ============================================================================
// FORCE RETURN TO MAIN LINE FROM CHART
// ============================================================================

function jumpToMainLineFromChart(index) {

// -------------------------------------------------------------------------
// RESET DEVIATION
// -------------------------------------------------------------------------
historyVariations = [];
deviationStartIndex = 0;
in_deviation = false;
currentVariationIndex = -1;

// -------------------------------------------------------------------------
// RESTORE MAIN LINE TO TARGET POINT
// -------------------------------------------------------------------------
currentMainlineIndex = index + 1;
pgn_index = index + 1;

game_fen = historyMain[index].fen_after;

// -------------------------------------------------------------------------
// UPDATE BOARD
// -------------------------------------------------------------------------
board.position(fenToPos(game_fen));

// -------------------------------------------------------------------------
// UI REFRESH
// -------------------------------------------------------------------------
renderHistory();
updatePgnNav();

// -------------------------------------------------------------------------
// ANALYZE POSITION
// -------------------------------------------------------------------------
const prev_fen = historyMain[index].fen_before;
const last_move_uci = historyMain[index].uci;

analyzeCurrentPosition(prev_fen, last_move_uci);
}

/* Deviations PGN format */

function formatMoveNumber(indexInFullLine) {
  return Math.floor(indexInFullLine / 2) + 1;
}

/**
 * Standardizes API fetch requests.
 * @param {string} path - The API endpoint to request.
 * @param {Object} [body] - The JSON payload.
 * @returns {Promise<Object>} The resolved JSON payload from the API.
 */
async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

/**
 * Extracts the purely positional layout from a full FEN string.
 * @param {string} fen - The full FEN string.
 * @returns {string} The positional part of the FEN.
 */
function fenToPos(fen) { 
  return fen.split(" ")[0]; 
}

/**
 * Updates the evaluation bar UI based on engine score.
 * @param {number} score - Centipawn score or mate score parsed from engine.
 */
function updateEvalBar(score) {
  const clamped = Math.max(-10, Math.min(10, score));
  const pct = ((clamped + 10) / 20) * 100;
  document.getElementById("evalFill").style.height = pct + "%";
  document.getElementById("evalText").textContent =
    (score >= 0 ? "+" : "") + score.toFixed(1);
}

/**
 * Renders the top suggested moves returned from the engine.
 * @param {Array<Object>} moves - Array of evaluated move objects.
 */
 function renderMovesList(moves, elementId, isAlternative = false) {
  const ul = document.getElementById(elementId);
  ul.innerHTML = "";
  
  if (!moves || moves.length === 0) {
    ul.innerHTML = `<li style="color:#666; font-style:italic; pointer-events: none;">N/A ${isAlternative ? '(Starting Pos)' : ''}</li>`;
    return;
  }

  moves.forEach((m, i) => {
    const li = document.createElement("li");
  
    const mainRow = document.createElement("div");
    mainRow.className = "move-row-main";
    mainRow.innerHTML = `
      <span>
        <span class="rank">${i+1}.</span>
        <span class="san">${m.san}</span>
      </span>
      <span class="score">${m.score >= 0 ? "+" : ""}${m.score.toFixed(2)}</span>
    `;

    const continuationRow = document.createElement("div");
    continuationRow.className = "continuation-text";
    continuationRow.textContent = m.continuation;

    li.appendChild(mainRow);
    li.appendChild(continuationRow);
    
    if (!isAlternative) {
       li.onclick = () => playMoveUci(m.uci);
    } else {
       li.onclick = () => playAlternativeMove(m.uci);
       li.title = "Click to play this alternative and create a variation";
       li.style.cursor = "pointer"; // Ripristina il puntatore
    }
    
    ul.appendChild(li);
  });
}

function revertOneStep() {
  if (in_deviation) {
      const movesToKeep = currentVariationIndex - 1;
      historyVariations = historyVariations.slice(0, movesToKeep);
      
      if (historyVariations.length > 0) {
          const last = historyVariations[historyVariations.length - 1];
          game_fen = last.fen_after;
          currentVariationIndex = historyVariations.length;
      } else {
          in_deviation = false;
          currentVariationIndex = -1;
          currentMainlineIndex = deviationStartIndex;
          pgn_index = deviationStartIndex;
          game_fen = deviationStartIndex > 0
              ? historyMain[deviationStartIndex - 1].fen_after
              : (pgn_fens.length > 0 ? pgn_fens[0] : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
      }
  } else {
      if (pgn_index > 0) {
          pgn_index--;
          currentMainlineIndex = pgn_index;
          game_fen = pgn_fens[pgn_index];
      }
  }
}

async function playAlternativeMove(uci) {
  if (is_moving) return;
  
  revertOneStep();
  
  board.position(fenToPos(game_fen));
  renderHistory();
  updatePgnNav();
  
  renderArrows([]);
  document.getElementById("topMoves").innerHTML = "<li>Branching...</li>";
  document.getElementById("altMoves").innerHTML = "<li>Branching...</li>";
  await playMoveUci(uci);
}

/**
 * Renders the move classification (e.g., Blunder, Brilliant, Good).
 * @param {Object|null} c - The classification object from the API.
 */
function renderClassification(c) {
  const card = document.getElementById("classificationCard");
  const sym = document.getElementById("classSymbol");
  const lab = document.getElementById("classLabel");
  
  if (!c || c.error) {
    sym.textContent = "–"; lab.textContent = "Waiting";
    card.style.borderColor = "#333"; sym.style.color = "#888";
    return;
  }
  
  sym.textContent = c.symbol;
  lab.textContent = c.label;
  sym.style.color = c.color;
  card.style.borderColor = c.color;
}

/**
 * Master method that delegates rendering of both history segments.
 */
function renderHistory() {
  renderMain();
  renderVariations();
}

/**
 * Renders the primary history line moves into the DOM.
 */
function renderMain() {
  const div = document.getElementById("historyMain");
  div.innerHTML = "";

  if (!historyMain.length) {
    div.innerHTML = "—";
    return;
  }

  for (let i = 0; i < historyMain.length; i += 2) {
    const row = document.createElement("div");
    row.className = "history-row";

    const moveNumber = Math.floor(i / 2) + 1;

    const numCell = document.createElement("div");
    numCell.className = "move-number";
    numCell.textContent = `${moveNumber}.`;

    const whiteCell = document.createElement("div");
    whiteCell.className = "move-cell";

    const whiteMove = historyMain[i];
    if (whiteMove) {
      let txt = whiteMove.san;
      if (whiteMove.evalData?.symbol && whiteMove.evalData.symbol !== "–") {
        txt += whiteMove.evalData.symbol;
      }

      whiteCell.textContent = txt;
      whiteCell.onclick = () => jumpToMove(i, true);

      if (!in_deviation && currentMainlineIndex - 1 === i) {
        whiteCell.classList.add("active-main");
      }

      if (whiteMove.evalData?.color) {
        whiteCell.style.color = whiteMove.evalData.color;
      }
    }

    const blackCell = document.createElement("div");
    blackCell.className = "move-cell";

    const blackMove = historyMain[i + 1];
    if (blackMove) {
      let txt = blackMove.san;
      if (blackMove.evalData?.symbol && blackMove.evalData.symbol !== "–") {
        txt += blackMove.evalData.symbol;
      }

      blackCell.textContent = txt;
      blackCell.onclick = () => jumpToMove(i + 1, true);

      if (!in_deviation && currentMainlineIndex - 1 === i + 1) {
        blackCell.classList.add("active-main");
      }

      if (blackMove.evalData?.color) {
        blackCell.style.color = blackMove.evalData.color;
      }
    }

    row.appendChild(numCell);
    row.appendChild(whiteCell);
    row.appendChild(blackCell);

    div.appendChild(row);
  }
}

/**
 * Renders the deviation branch moves into the DOM.
 */
 function renderVariations() {
  const div = document.getElementById("historyVariations");
  div.innerHTML = "";

  if (!historyVariations.length) {
    div.innerHTML = "—";
    return;
  }

  // --- Header / indicator ---
  const prefix = document.createElement("div");
  prefix.className = "variation-prefix";
  prefix.textContent =
    `Following main line until move ${Math.ceil(deviationStartIndex / 2)}`;
  div.appendChild(prefix);

  const inheritedLine = historyMain.slice(0, deviationStartIndex);
  const deviationLine = historyVariations;

  const fullLine = [...inheritedLine, ...deviationLine];

  for (let i = 0; i < fullLine.length; i += 2) {

    // --- Deviation separator ---
    if (i === deviationStartIndex || i + 1 === deviationStartIndex) {
      const separator = document.createElement("div");
      separator.className = "deviation-separator";
      separator.textContent = "↳ Deviation starts";
      div.appendChild(separator);
    }

    const row = document.createElement("div");
    row.className = "history-row";

    const moveNumber = Math.floor(i / 2) + 1;

    const numCell = document.createElement("div");
    numCell.className = "move-number";
    numCell.textContent = `${moveNumber}.`;

    // ---------------- WHITE ----------------
    const whiteCell = document.createElement("div");
    whiteCell.className = "move-cell";

    const whiteMove = fullLine[i];

    if (whiteMove) {
      let txt = whiteMove.san;

      if (whiteMove.evalData?.symbol && whiteMove.evalData.symbol !== "–") {
        txt += whiteMove.evalData.symbol;
      }

      whiteCell.textContent = txt;

      const isInherited = i < deviationStartIndex;

      if (isInherited) {
        whiteCell.classList.add("inherited-move");
      } else {
        const localIndex = i - deviationStartIndex;

        whiteCell.onclick = () => jumpToMove(localIndex, false);

        if (currentVariationIndex - 1 === localIndex) {
          whiteCell.classList.add("active-var");
        }
      }

      if (whiteMove.evalData?.color) {
        whiteCell.style.color = whiteMove.evalData.color;
      }
    }

    // ---------------- BLACK ----------------
    const blackCell = document.createElement("div");
    blackCell.className = "move-cell";

    const blackMove = fullLine[i + 1];

    if (blackMove) {
      let txt = blackMove.san;

      if (blackMove.evalData?.symbol && blackMove.evalData.symbol !== "–") {
        txt += blackMove.evalData.symbol;
      }

      blackCell.textContent = txt;

      const isInherited = (i + 1) < deviationStartIndex;

      if (isInherited) {
        blackCell.classList.add("inherited-move");
      } else {
        const localIndex = (i + 1) - deviationStartIndex;

        blackCell.onclick = () => jumpToMove(localIndex, false);

        if (currentVariationIndex - 1 === localIndex) {
          blackCell.classList.add("active-var");
        }
      }

      if (blackMove.evalData?.color) {
        blackCell.style.color = blackMove.evalData.color;
      }
    }

    row.appendChild(numCell);
    row.appendChild(whiteCell);
    row.appendChild(blackCell);

    div.appendChild(row);
  }
}
/**
 * Restores board state to a previously logged move.
 * @param {number} index - Index in the respective array.
 * @param {boolean} isMainLine - Whether the target move belongs to the main line.
 */
function jumpToMove(index, isMainLine) {
  let targetMove;

  if (isMainLine) {
    targetMove = historyMain[index];
    currentMainlineIndex = index + 1;
    historyVariations = [];
    currentVariationIndex = -1;
    in_deviation = false;
    pgn_index = currentMainlineIndex;
  } else {
    targetMove = historyVariations[index];
    currentVariationIndex = index + 1;
    in_deviation = true;
  }

  game_fen = targetMove.fen_after;
  board.position(fenToPos(game_fen));

  renderHistory();
  updatePgnNav();
  analyzeCurrentPosition(targetMove.fen_before, targetMove.uci);
}

/**
 * Draws graphical arrows over the board for the top suggested moves.
 * @param {Array<Object>} moves - Array of evaluated move objects.
 */
function renderArrows(moves) {
  document.querySelectorAll(".move-arrow").forEach(e => e.remove());
  if (!moves || !moves.length) return;
  
  const boardEl = document.getElementById("board");
  const rect = boardEl.getBoundingClientRect();
  const sqSize = rect.width / 8;
  const orient = board.orientation();
  const svgNS = "http://www.w3.org/2000/svg";
  
  const svg = document.createElementNS(svgNS, "svg");
  svg.classList.add("move-arrow");
  svg.setAttribute("width", rect.width);
  svg.setAttribute("height", rect.height);
  svg.style.position = "absolute"; 
  svg.style.top = "0"; 
  svg.style.left = "0"; 
  svg.style.pointerEvents = "none";
  
  const colors = ["#00d26a", "#26bbff", "#f0c15c"];

  moves.forEach((m, i) => {
    const [fx, fy] = sqToXY(m.from, sqSize, orient);
    const [tx, ty] = sqToXY(m.to, sqSize, orient);
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", fx); line.setAttribute("y1", fy);
    line.setAttribute("x2", tx); line.setAttribute("y2", ty);
    line.setAttribute("stroke", colors[i] || "#888");
    line.setAttribute("stroke-width", 7);
    line.setAttribute("opacity", 0.8);
    line.setAttribute("marker-end", `url(#arrow${i})`);
    
    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", `arrow${i}`);
    marker.setAttribute("markerWidth", "3"); 
    marker.setAttribute("markerHeight", "3");
    marker.setAttribute("refX", "2"); 
    marker.setAttribute("refY", "1.5");
    marker.setAttribute("orient", "auto");
    
    const tri = document.createElementNS(svgNS, "polygon");
    tri.setAttribute("points", "0,0 3,1.5 0,3");
    tri.setAttribute("fill", colors[i] || "#888");
    marker.appendChild(tri);
    defs.appendChild(marker);
    svg.appendChild(defs);
    svg.appendChild(line);
  });
  
  boardEl.style.position = "relative";
  boardEl.appendChild(svg);
}

/**
 * Converts algebraic notation squares to pixel coordinate vectors relative to the SVG container.
 * @param {string} sq - The algebraic square (e.g., "e4").
 * @param {number} sqSize - Width/height of one square in px.
 * @param {string} orient - Board orientation ('white' or 'black').
 * @returns {Array<number>} An array containing [X, Y] coordinates.
 */
function sqToXY(sq, sqSize, orient) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  let x, y;
  if (orient === "white") {
    x = file * sqSize + sqSize/2; y = (7 - rank) * sqSize + sqSize/2;
  } else {
    x = (7 - file) * sqSize + sqSize/2; y = rank * sqSize + sqSize/2;
  }
  return [x, y];
}

// ============================================================================
// CORE FLOW & ENGINE REQUESTS
// ============================================================================

/**
 * Triggers backend evaluation for the current position state.
 * @param {string|null} prev_fen - FEN string prior to the last move.
 * @param {string|null} last_move_uci - UCI notation of the move leading to current FEN.
 */
async function analyzeCurrentPosition(prev_fen = null, last_move_uci = null) {
  const depth = parseInt(document.getElementById("depth").value, 10) || 14;
  const topMovesEl = document.getElementById("topMoves");
  const openingEl = document.getElementById("openingName");

  if (topMovesEl) topMovesEl.innerHTML = "<li style='color:#888;'>Analyzing…</li>";
  renderArrows([]);
  renderClassification(null);

  try {
    const data = await api("/api/analyze", {
      fen: game_fen,
      depth,
      prev_fen,
      last_move_uci,
    });
  
    topMovesCache = data.top_moves;
    updateEvalBar(data.eval);
    renderMovesList(data.top_moves, "topMoves", false);
    renderMovesList(data.alternative_moves, "altMoves", true);
    
    renderClassification(data.classification);
    renderArrows(data.top_moves);

    if (data.opening && data.opening !== "Custom Position") {
      currentOpeningName = data.opening;
      openingEl.textContent = currentOpeningName;
    } else {
      openingEl.textContent = !in_deviation ? (currentOpeningName || "Starting Position") : "Custom Position";
    }

  } catch (e) {
    console.error("Error during analysis:", e);
    if (topMovesEl) {
      topMovesEl.innerHTML = `<li style='color:#e6912c;'>Error: ${e.message}</li>`;
    }
  }
}

/**
 * Handles the application of an explicit engine/suggested move.
 * @param {string} uci - The UCI string of the intended move (e.g. 'e2e4').
 */
async function playMoveUci(uci) {
  if (is_moving) return;
  is_moving = true;

  try {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.length > 4 ? uci[4] : "q";
    const result = await api("/api/legal_moves", { fen: game_fen, from, to, promotion: promo });
    if (!result.legal) return;
    pushMove(result, game_fen);
  } finally {
    is_moving = false;
  }
}

/**
 * Commits a legally verified move into the state machine and visual layers.
 * @param {Object} legalResult - Payload returning from /api/legal_moves.
 * @param {string} fen_before - The game FEN state prior to the move.
 */
 function pushMove(legalResult, fen_before) {
  const moveObj = {
    san: legalResult.san,
    uci: legalResult.uci,
    fen_before,
    fen_after: legalResult.new_fen,
    evalData: null // verrà popolato dopo analisi
  };

  if (!in_deviation) {
    if (
      pgn_moves.length > 0 &&
      pgn_index < pgn_moves.length &&
      pgn_moves[pgn_index].uci === legalResult.uci
    ) {
      currentMainlineIndex++;
      pgn_index++;
    } else {
      in_deviation = true;
      deviationStartIndex = currentMainlineIndex;
      historyVariations = [];
      currentVariationIndex = 1;
      historyVariations.push(moveObj);
    }
  } else {
    historyVariations.push(moveObj);
    currentVariationIndex++;
  }

  game_fen = legalResult.new_fen;
  board.position(fenToPos(game_fen));

  renderHistory();
  updatePgnNav();

  analyzeCurrentPosition(fen_before, legalResult.uci).then(async () => {
    try {
      const analysis = await api("/api/analyze", {
        fen: legalResult.new_fen,
        prev_fen: fen_before,
        last_move_uci: legalResult.uci,
        depth: parseInt(document.getElementById("depth").value, 10) || 14
      });

      moveObj.evalData = analysis.classification;

      renderHistory();

    } catch (e) {
      console.error("Deviation move classification failed:", e);
    }
  });
}

// ============================================================================
// PROMOTION MODAL & LOGIC
// ============================================================================

/**
 * Opens a modal to request which piece the user intends to promote to.
 * @param {string} color - 'white' or 'black'.
 * @returns {Promise<string|null>} A promise returning piece code ("q", "r", "b", "n") or null if canceled.
 */
function askPromotion(color) {
  return new Promise((resolve) => {
    const modal = document.getElementById("promoModal");
    const piecesEl = document.getElementById("promoPieces");
    const cancelBtn = document.getElementById("promoCancel");
    piecesEl.innerHTML = "";
    
    const pieces = [
      {code: "q", label: "Queen"}, 
      {code: "r", label: "Rook"}, 
      {code: "b", label: "Bishop"}, 
      {code: "n", label: "Knight"}
    ];
    const colorPrefix = color === "white" ? "w" : "b";

    pieces.forEach(p => {
      const btn = document.createElement("button");
      btn.className = "promo-piece";
      const img = document.createElement("img");
      img.src = `https://chessboardjs.com/img/chesspieces/wikipedia/${colorPrefix}${p.code.toUpperCase()}.png`;
      btn.appendChild(img);
      btn.onclick = () => { close(p.code); };
      piecesEl.appendChild(btn);
    });

    function close(value) {
      modal.classList.add("hidden");
      document.removeEventListener("keydown", onKey);
      resolve(value);
    }
    
    function onKey(e) { if (e.key === "Escape") close(null); }
    cancelBtn.onclick = () => close(null);
    document.addEventListener("keydown", onKey);
    modal.classList.remove("hidden");
  });
}

// ============================================================================
// OPENINGS LOGIC
// ============================================================================

const openingsModal = document.getElementById("openingsModal");

/**
 * Renders the filtered cachedOpenings dictionary into the modal view.
 * @param {string} filterText - The search substring.
 */
function renderOpeningsList(filterText = "") {
  const listEl = document.getElementById("openingsList");
  listEl.innerHTML = "";
  const query = filterText.toLowerCase();

  for (const [name, pgn] of Object.entries(cachedOpenings)) {
    if (name.toLowerCase().includes(query)) {
      const item = document.createElement("div");
      item.className = "opening-item";
      const pgnString = Array.isArray(pgn) ? pgn[0] : pgn;
      
      item.innerHTML = `
        <span class="opening-name">${name}</span>
        <span class="opening-moves">${pgnString.substring(0, 50)}...</span>
      `;
      item.onclick = () => {
        document.getElementById("pgnInput").value = pgnString;
        document.getElementById("loadPgnBtn").click();
        openingsModal.classList.add("hidden");
      };
      listEl.appendChild(item);
    }
  }
  if (listEl.innerHTML === "") {
    listEl.innerHTML = "<div style='color: #888;'>No openings found.</div>";
  }
}

/** Fetches and presents known opening setups */
document.getElementById("openingsBtn").onclick = async () => {
  const listEl = document.getElementById("openingsList");
  listEl.innerHTML = "Loading...";
  document.getElementById("openingSearch").value = "";
  openingsModal.classList.remove("hidden");

  try {
    const response = await fetch("/api/list_openings");
    cachedOpenings = await response.json();
    renderOpeningsList("");
  } catch (e) {
    listEl.innerHTML = "Error loading openings.";
  }
};

/** Search filter logic */
document.getElementById("openingSearch").addEventListener("input", (e) => {
  renderOpeningsList(e.target.value);
});

document.getElementById("closeOpenings").onclick = () => openingsModal.classList.add("hidden");

// ============================================================================
// CHESSBOARD.JS HOOKS
// ============================================================================

/**
 * Callback fired when a piece is dropped onto the board visually.
 * @param {string} source - Start square.
 * @param {string} target - End square.
 * @param {string} piece - Piece ID (e.g. 'wP').
 */
function onDrop(source, target, piece) {
  if (in_deviation && !isAtDeviationTip()) {
    return "snapback";
  }
  if (source === target) return "snapback";
  const isPromotion = (piece === "wP" && target[1] === "8") || (piece === "bP" && target[1] === "1");
  
  if (isPromotion) {
    handlePromotion(source, target, piece === "wP" ? "white" : "black");
    // Return snapback instantly; we'll redraw correctly after API response / user choice
    return "snapback"; 
  }
  handleNormalMove(source, target);
}

/**
 * Handles processing of standard non-promotion moves via the API validation endpoint.
 * @param {string} source - Start square.
 * @param {string} target - End square.
 */
 async function handleNormalMove(source, target) {
  if (is_moving) { 
    board.position(fenToPos(game_fen)); 
    return; 
  }

  if (in_deviation && !isAtDeviationTip()) {
    board.position(fenToPos(game_fen));
    return;
  }

  is_moving = true;

  try {
    const fen_before = game_fen;
    const result = await api("/api/legal_moves", {
      fen: game_fen,
      from: source,
      to: target,
      promotion: "q"
    });

    if (!result.legal) {
      board.position(fenToPos(game_fen));
      return;
    }

    pushMove(result, fen_before);

  } finally {
    is_moving = false;
  }
}

/**
 * Handles piece promotion scenarios, pre-validating legality before showing modals.
 * @param {string} source - Start square.
 * @param {string} target - End square.
 * @param {string} color - The color string ('white', 'black') of the promoting piece.
 */
async function handlePromotion(source, target, color) {
  if (in_deviation && !isAtDeviationTip()) {
    board.position(fenToPos(game_fen));
    return;
  }
  if (is_moving) { 
    board.position(fenToPos(game_fen)); 
    return; 
  }
  is_moving = true;

  try {
    const fen_before = game_fen;
    
    // 1. Verify legality of the promotion first using a dummy "q" promotion request
    const legalityCheck = await api("/api/legal_moves", { fen: game_fen, from: source, to: target, promotion: "q" });
    if (!legalityCheck.legal) { 
      board.position(fenToPos(game_fen)); 
      return; 
    }

    // 2. Since the move is legal, ask user for the exact piece mapping
    const choice = await askPromotion(color);
    if (!choice) {
      board.position(fenToPos(game_fen)); 
      return;
    }
    
    // 3. Request final execution payload using chosen promotion piece
    const result = await api("/api/legal_moves", { fen: game_fen, from: source, to: target, promotion: choice });
    if (result.legal) pushMove(result, fen_before);
    
  } finally {
    is_moving = false;
  }
}

/** Corrects visual bugs via a layout refresh sync. */
function onSnapEnd() { board.position(fenToPos(game_fen)); }

// ============================================================================
// BUTTONS & ACTIONS
// ============================================================================

const moveSlider = document.getElementById("moveSlider");

/** Submits the raw PGN data block via the API to resolve FEN vectors. */
document.getElementById("loadPgnBtn").onclick = async () => {
  const txt = document.getElementById("pgnInput").value.trim();
  if (!txt) return;

  const depth = parseInt(document.getElementById("depth").value, 10) || 14;

  const overlay = document.getElementById("loadingOverlay");
  const loadingText = document.getElementById("loadingText");
  overlay.classList.remove("hidden");

  try {
    const data = await api("/api/load_pgn", { pgn: txt });

    pgn_moves = data.moves || [];
    pgn_fens = data.fens || [];

    // =========================================================================
    // ANALYZE EVERY MOVE
    // =========================================================================
    for (let i = 0; i < pgn_moves.length; i++) {
      loadingText.textContent = `Analyzing move ${i + 1} of ${pgn_moves.length}...`;

      const analysis = await api("/api/analyze", {
        fen: pgn_fens[i + 1],
        prev_fen: pgn_fens[i],
        last_move_uci: pgn_moves[i].uci,
        depth: depth
      });

      pgn_moves[i].evalData = analysis.classification;
      pgn_moves[i].eval = analysis.eval;
      pgn_moves[i].cpLoss = Math.max(
        0,
        analysis.best_eval_loss || 0
      );
    }

    // =========================================================================
    // BUILD FULL MAIN LINE HISTORY
    // =========================================================================
    historyMain = [];

    for (let i = 0; i < pgn_moves.length; i++) {
      historyMain.push({
        san: pgn_moves[i].san,
        uci: pgn_moves[i].uci,
        fen_before: pgn_fens[i],
        fen_after: pgn_fens[i + 1],
        evalData: pgn_moves[i].evalData,
        cpLoss: pgn_moves[i].cpLoss,
        eval: pgn_moves[i].eval
      });
    }

    // =========================================================================
    // RESET VARIATION STATE
    // =========================================================================
    historyVariations = [];
    deviationStartIndex = 0;

    // =========================================================================
    // SET POSITION TO END OF GAME
    // =========================================================================
    pgn_index = pgn_moves.length;
    currentMainlineIndex = pgn_moves.length;
    currentVariationIndex = -1;
    in_deviation = false;

    game_fen = pgn_fens[pgn_moves.length];

    moveSlider.max = pgn_moves.length;
    moveSlider.value = pgn_moves.length;

    board.position(fenToPos(game_fen));

    // =========================================================================
    // UI REFRESH
    // =========================================================================
    renderHistory();
    updatePgnNav();

    calculateGameAccuracy();
    renderEvalChart();

    overlay.classList.add("hidden");

    // =========================================================================
    // FINAL POSITION ANALYSIS
    // =========================================================================
    analyzeCurrentPosition(
      pgn_moves.length > 0 ? pgn_fens[pgn_moves.length - 1] : null,
      pgn_moves.length > 0 ? pgn_moves[pgn_moves.length - 1].uci : null
    );

  } catch (e) {
    overlay.classList.add("hidden");
    alert("Error loading PGN");
    console.error(e);
  }
};

/** Re-initializes state variables to starting position. */
document.getElementById("resetBtn").onclick = () => {
  game_fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  historyMain = []; historyVariations = []; pgn_index = 0; in_deviation = false; pgn_moves = []; pgn_fens = [];
  board.position("start");
  document.getElementById("pgnInput").value = "";
  renderHistory(); updatePgnNav(); analyzeCurrentPosition();
};

/** Toggles board orientation between Black & White. */
document.getElementById("flipBtn").onclick = () => board.flip();

/** Pops a move off the applicable history array stack. */
document.getElementById("undoBtn").onclick = () => {
  if (historyVariations.length > 0) {

    historyVariations.pop();

    if (historyVariations.length > 0) {
      const last = historyVariations[historyVariations.length - 1];

      game_fen = last.fen_after;
      currentVariationIndex = historyVariations.length;

      in_deviation = true;

    } else {
      in_deviation = false;
      currentVariationIndex = -1;

      currentMainlineIndex = deviationStartIndex;
      pgn_index = deviationStartIndex;

      game_fen = deviationStartIndex > 0
        ? historyMain[deviationStartIndex - 1].fen_after
        : pgn_fens[0];
    }

    board.position(fenToPos(game_fen));

    renderHistory();
    updatePgnNav();

    let prev_fen = null;
    let last_move_uci = null;

    if (historyVariations.length > 0) {
      const last = historyVariations[historyVariations.length - 1];
      prev_fen = last.fen_before;
      last_move_uci = last.uci;

    } else if (in_deviation === false && currentMainlineIndex > 0) {
      prev_fen = historyMain[currentMainlineIndex - 1].fen_before;
      last_move_uci = historyMain[currentMainlineIndex - 1].uci;
    }

    analyzeCurrentPosition(prev_fen, last_move_uci);
  }
};

/** Lock from deviations on deviation */
function isAtDeviationTip() {
  return in_deviation && currentVariationIndex === historyVariations.length;
}

/** Updates pagination labels dependent on loaded states. */
function updatePgnNav() {
  const total = pgn_moves.length;
  const pos = document.getElementById("pgnPos");
  const sliderMaxLabel = document.getElementById("sliderMax");

  moveSlider.max = total;
  moveSlider.value = pgn_index;
  sliderMaxLabel.textContent = total;

  if (total === 0) {
    pos.textContent = "0 / 0";
    document.getElementById("pgnPrev").disabled = true;
    document.getElementById("pgnNext").disabled = true;
    return;
  }

  pos.textContent = `${pgn_index} / ${total}` + (in_deviation ? " (var)" : "");

  document.getElementById("pgnPrev").disabled = false;
  document.getElementById("pgnNext").disabled = false;

  if (evalChart) {
    evalChart.update();
  }
}

/** Steps the board forward following the primary loaded PGN branch. */
document.getElementById("pgnNext").onclick = () => {
  if (pgn_index < pgn_moves.length) {
    pgn_index++;
    currentMainlineIndex = pgn_index;
    in_deviation = false;
    historyVariations = [];
    currentVariationIndex = -1;

    game_fen = pgn_fens[pgn_index];
    board.position(fenToPos(game_fen));

    renderHistory();
    updatePgnNav();

    const prev_fen = pgn_index > 0 ? pgn_fens[pgn_index - 1] : null;
    const last_move_uci = pgn_index > 0 ? pgn_moves[pgn_index - 1].uci : null;

    analyzeCurrentPosition(prev_fen, last_move_uci);
  }
};

document.getElementById("pgnPrev").onclick = () => {
  if (pgn_index > 0) {
    pgn_index--;
    currentMainlineIndex = pgn_index;
    in_deviation = false;
    historyVariations = [];
    currentVariationIndex = -1;

    game_fen = pgn_fens[pgn_index];
    board.position(fenToPos(game_fen));

    renderHistory();
    updatePgnNav();

    const prev_fen = pgn_index > 0 ? pgn_fens[pgn_index - 1] : null;
    const last_move_uci = pgn_index > 0 ? pgn_moves[pgn_index - 1].uci : null;

    analyzeCurrentPosition(prev_fen, last_move_uci);
  }
};

// ============================================================================
// SLIDER LOGIC
// ============================================================================

/**
 * Reconstructs the history trail up to a specified index point.
 * @param {number} upToIndex - Target bounds.
 */
 function rebuildHistoryMain(upToIndex) {
  historyMain = [];
  for (let i = 0; i < upToIndex; i++) {
    historyMain.push({
      san: pgn_moves[i].san,
      uci: pgn_moves[i].uci,
      fen_before: pgn_fens[i],
      fen_after: pgn_fens[i + 1],
      evalData: pgn_moves[i].evalData
    });
  }
}

/** Handles slider dragging natively */
moveSlider.addEventListener("input", function() {
  const targetIndex = parseInt(this.value);

  if (pgn_moves.length > 0 && pgn_fens.length > targetIndex) {
    pgn_index = targetIndex;
    currentMainlineIndex = targetIndex;

    in_deviation = false;
    historyVariations = [];
    currentVariationIndex = -1;

    game_fen = pgn_fens[targetIndex];
    board.position(fenToPos(game_fen), false);

    renderHistory();
    updatePgnNav();

    document.getElementById("topMoves").innerHTML =
      "<li style='color:#888;'>Sliding...</li>";

    renderArrows([]);
  }
});

/** Resolves final analysis evaluation upon slider release */
moveSlider.addEventListener("change", function() {
  let prev_fen = null;
  let last_move_uci = null;

  if (pgn_index > 0) {
    prev_fen = pgn_fens[pgn_index - 1];
    last_move_uci = pgn_moves[pgn_index - 1].uci;
  }

  analyzeCurrentPosition(prev_fen, last_move_uci);
});

// ============================================================================
// INITIALIZATION
// ============================================================================

window.addEventListener("load", () => {
  board = Chessboard("board", {
    position: "start", 
    draggable: true,
    onDrop: onDrop, 
    onSnapEnd: onSnapEnd,
    pieceTheme: "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  });

  window.addEventListener("resize", () => {
    board.resize();
    renderArrows(topMovesCache);
  });
  
  analyzeCurrentPosition();
});
