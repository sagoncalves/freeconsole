/**
 * Chess rules, shared by the screen and the controller.
 *
 * The screen is authoritative — it is the only place a move is ever applied. The
 * controller loads this too, but only to grey out squares it already knows are illegal,
 * so a tap that can't work never costs a round trip. If the two ever disagree, the
 * screen's board is broadcast back and the controller redraws from it.
 *
 * Board representation is a flat 64-array, index 0 = a8, index 63 = h1 — reading order,
 * so `board[r * 8 + f]` matches how both views draw it. A piece is a two-character
 * string: colour ("w"/"b") + kind ("p n b r q k"). An empty square is null.
 */

export const WHITE = "w";
export const BLACK = "b";

/** Starting position, in reading order from a8. */
const BACK_RANK = ["r", "n", "b", "q", "k", "b", "n", "r"];

export function initialBoard() {
  const board = new Array(64).fill(null);
  for (let f = 0; f < 8; f++) {
    board[f] = BLACK + BACK_RANK[f];          // rank 8
    board[8 + f] = BLACK + "p";               // rank 7
    board[48 + f] = WHITE + "p";              // rank 2
    board[56 + f] = WHITE + BACK_RANK[f];     // rank 1
  }
  return board;
}

export function initialState() {
  return {
    board: initialBoard(),
    turn: WHITE,
    // Castling rights, revoked as soon as the king or the relevant rook moves.
    castling: { wk: true, wq: true, bk: true, bq: true },
    // Target square index for en passant, or null. Set only for the single move
    // immediately after a double pawn push.
    enPassant: null,
    halfmove: 0,   // plies since the last capture or pawn move, for the 50-move rule
    fullmove: 1,
  };
}

export const colorOf = (piece) => (piece ? piece[0] : null);
export const kindOf = (piece) => (piece ? piece[1] : null);
export const opposite = (color) => (color === WHITE ? BLACK : WHITE);

export const fileOf = (i) => i % 8;
export const rankOf = (i) => (i / 8) | 0;   // 0 = rank 8, 7 = rank 1
export const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
export const idx = (f, r) => r * 8 + f;

/** "e4"-style name, for move logs and the controller's readout. */
export function squareName(i) {
  return "abcdefgh"[fileOf(i)] + (8 - rankOf(i));
}

/* ------------------------------------------------------------------ moves */

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const ROOK_RAYS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * Every move a piece could make ignoring check. Castling and en passant are included;
 * legality (leaving your own king attacked) is filtered later in legalMoves().
 */
function pseudoMoves(state, from) {
  const { board } = state;
  const piece = board[from];
  if (!piece) return [];

  const me = colorOf(piece);
  const them = opposite(me);
  const kind = kindOf(piece);
  const f = fileOf(from), r = rankOf(from);
  const out = [];

  const push = (tf, tr, extra) => {
    if (!onBoard(tf, tr)) return false;
    const to = idx(tf, tr);
    const target = board[to];
    if (target && colorOf(target) === me) return false;
    out.push({ from, to, ...extra });
    return !target;   // false once we hit a piece, so rays stop
  };

  if (kind === "p") {
    // White moves toward rank 8, which is toward index 0 — so "forward" is -1 in rank.
    const dir = me === WHITE ? -1 : 1;
    const startRank = me === WHITE ? 6 : 1;
    const promoRank = me === WHITE ? 0 : 7;

    const oneAhead = r + dir;
    if (onBoard(f, oneAhead) && !board[idx(f, oneAhead)]) {
      if (oneAhead === promoRank) {
        for (const promo of ["q", "r", "b", "n"]) out.push({ from, to: idx(f, oneAhead), promo });
      } else {
        out.push({ from, to: idx(f, oneAhead) });
        // The double push is only available from the home rank and only if both
        // squares are clear.
        const twoAhead = r + dir * 2;
        if (r === startRank && !board[idx(f, twoAhead)]) {
          out.push({ from, to: idx(f, twoAhead), double: true });
        }
      }
    }

    for (const df of [-1, 1]) {
      const cf = f + df, cr = r + dir;
      if (!onBoard(cf, cr)) continue;
      const to = idx(cf, cr);
      const target = board[to];
      if (target && colorOf(target) === them) {
        if (cr === promoRank) {
          for (const promo of ["q", "r", "b", "n"]) out.push({ from, to, promo });
        } else {
          out.push({ from, to });
        }
      } else if (to === state.enPassant) {
        // The captured pawn is beside us, not on the target square.
        out.push({ from, to, enPassant: idx(cf, r) });
      }
    }
    return out;
  }

  if (kind === "n") {
    for (const [df, dr] of KNIGHT_STEPS) push(f + df, r + dr);
    return out;
  }

  if (kind === "k") {
    for (const [df, dr] of KING_STEPS) push(f + df, r + dr);

    // Castling: rights intact, squares between empty, and the king neither starts in,
    // passes through, nor lands on an attacked square. The pass-through test is the one
    // that is easy to forget and produces illegal castles out of check.
    const homeRank = me === WHITE ? 7 : 0;
    if (r === homeRank && f === 4 && !isAttacked(state, from, them)) {
      const canK = me === WHITE ? state.castling.wk : state.castling.bk;
      const canQ = me === WHITE ? state.castling.wq : state.castling.bq;
      if (canK && !board[idx(5, r)] && !board[idx(6, r)] &&
          !isAttacked(state, idx(5, r), them) && !isAttacked(state, idx(6, r), them)) {
        out.push({ from, to: idx(6, r), castle: "k" });
      }
      if (canQ && !board[idx(3, r)] && !board[idx(2, r)] && !board[idx(1, r)] &&
          !isAttacked(state, idx(3, r), them) && !isAttacked(state, idx(2, r), them)) {
        out.push({ from, to: idx(2, r), castle: "q" });
      }
    }
    return out;
  }

  const rays = kind === "b" ? BISHOP_RAYS : kind === "r" ? ROOK_RAYS : BISHOP_RAYS.concat(ROOK_RAYS);
  for (const [df, dr] of rays) {
    let tf = f + df, tr = r + dr;
    while (push(tf, tr)) { tf += df; tr += dr; }
  }
  return out;
}

/** Is `square` attacked by `byColor`? Used for check, castling, and mate detection. */
export function isAttacked(state, square, byColor) {
  const { board } = state;
  const f = fileOf(square), r = rankOf(square);

  // Pawns: walk backwards from the target rather than scanning every enemy pawn.
  const pawnDir = byColor === WHITE ? 1 : -1;   // where the attacker sits, relative to us
  for (const df of [-1, 1]) {
    const af = f + df, ar = r + pawnDir;
    if (onBoard(af, ar) && board[idx(af, ar)] === byColor + "p") return true;
  }

  for (const [df, dr] of KNIGHT_STEPS) {
    const af = f + df, ar = r + dr;
    if (onBoard(af, ar) && board[idx(af, ar)] === byColor + "n") return true;
  }

  for (const [df, dr] of KING_STEPS) {
    const af = f + df, ar = r + dr;
    if (onBoard(af, ar) && board[idx(af, ar)] === byColor + "k") return true;
  }

  const slide = (rays, kinds) => {
    for (const [df, dr] of rays) {
      let af = f + df, ar = r + dr;
      while (onBoard(af, ar)) {
        const p = board[idx(af, ar)];
        if (p) {
          if (colorOf(p) === byColor && kinds.includes(kindOf(p))) return true;
          break;
        }
        af += df; ar += dr;
      }
    }
    return false;
  };
  if (slide(BISHOP_RAYS, ["b", "q"])) return true;
  if (slide(ROOK_RAYS, ["r", "q"])) return true;
  return false;
}

export function findKing(state, color) {
  const target = color + "k";
  for (let i = 0; i < 64; i++) if (state.board[i] === target) return i;
  return -1;
}

export function inCheck(state, color) {
  const king = findKing(state, color);
  return king >= 0 && isAttacked(state, king, opposite(color));
}

/**
 * Legal moves for one square, or for the whole side to move when `from` is omitted.
 * A pseudo-legal move is legal exactly when playing it does not leave your own king
 * attacked, so each candidate is applied to a copy and tested.
 */
export function legalMoves(state, from) {
  const me = state.turn;
  const squares = from === undefined
    ? Array.from({ length: 64 }, (_, i) => i).filter((i) => colorOf(state.board[i]) === me)
    : (colorOf(state.board[from]) === me ? [from] : []);

  const out = [];
  for (const sq of squares) {
    for (const move of pseudoMoves(state, sq)) {
      const next = applyMove(state, move, { validate: false });
      if (!inCheck(next, me)) out.push(move);
    }
  }
  return out;
}

/** Find the legal move matching a from/to (and optional promotion), or null. */
export function findMove(state, from, to, promo) {
  const moves = legalMoves(state, from);
  return moves.find((m) => m.to === to && (!m.promo || !promo || m.promo === promo)) || null;
}

/* ----------------------------------------------------------------- apply */

function cloneState(state) {
  return {
    board: state.board.slice(),
    turn: state.turn,
    castling: { ...state.castling },
    enPassant: state.enPassant,
    halfmove: state.halfmove,
    fullmove: state.fullmove,
  };
}

/**
 * Returns a NEW state with `move` played. Never mutates the input, so the legality
 * search above can try moves freely.
 *
 * The returned state carries a `.last` describing what happened — which square was
 * captured, whether a rook slid, whether a pawn promoted. The screen reads that to drive
 * its animations rather than diffing two boards.
 */
export function applyMove(state, move, opts = {}) {
  const next = cloneState(state);
  const { board } = next;
  const piece = board[move.from];
  const me = colorOf(piece);
  const kind = kindOf(piece);

  // The capture square is usually the destination, but en passant takes a pawn that is
  // standing beside the destination.
  const captureSquare = move.enPassant !== undefined ? move.enPassant : move.to;
  const captured = board[captureSquare] || null;

  board[move.from] = null;
  if (captured) board[captureSquare] = null;
  board[move.to] = move.promo ? me + move.promo : piece;

  // Castling moves the rook too. The king has already been placed above.
  let rookMove = null;
  if (move.castle) {
    const r = rankOf(move.to);
    const [rf, rt] = move.castle === "k" ? [7, 5] : [0, 3];
    rookMove = { from: idx(rf, r), to: idx(rt, r) };
    board[rookMove.to] = board[rookMove.from];
    board[rookMove.from] = null;
  }

  // Castling rights: lost when the king moves, when a rook leaves its corner, and also
  // when a rook is captured on its corner — that last one is the case a naive
  // implementation misses, letting you castle with a rook that no longer exists.
  const revoke = (sq) => {
    if (sq === 60) { next.castling.wk = false; next.castling.wq = false; }
    if (sq === 63) next.castling.wk = false;
    if (sq === 56) next.castling.wq = false;
    if (sq === 4) { next.castling.bk = false; next.castling.bq = false; }
    if (sq === 7) next.castling.bk = false;
    if (sq === 0) next.castling.bq = false;
  };
  revoke(move.from);
  revoke(move.to);
  if (captured) revoke(captureSquare);

  next.enPassant = move.double ? idx(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2) : null;
  next.halfmove = (captured || kind === "p") ? 0 : state.halfmove + 1;
  if (me === BLACK) next.fullmove = state.fullmove + 1;
  next.turn = opposite(me);

  next.last = {
    from: move.from,
    to: move.to,
    piece,
    color: me,
    captured,
    captureSquare: captured ? captureSquare : null,
    promo: move.promo || null,
    castle: move.castle || null,
    rookMove,
  };

  if (opts.validate !== false) next.check = inCheck(next, next.turn);
  return next;
}

/* --------------------------------------------------------------- outcomes */

/** "checkmate" | "stalemate" | "fifty" | "material" | null. */
export function outcome(state) {
  if (legalMoves(state).length === 0) {
    return inCheck(state, state.turn) ? "checkmate" : "stalemate";
  }
  if (state.halfmove >= 100) return "fifty";

  // Insufficient material: bare kings, or a king with a single minor piece.
  const pieces = state.board.filter(Boolean);
  if (pieces.length <= 3) {
    const minors = pieces.filter((p) => "nb".includes(kindOf(p)));
    if (pieces.length === 2 || minors.length === 1) return "material";
  }
  return null;
}
