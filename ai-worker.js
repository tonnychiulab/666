/* ============================================================
   六子棋 Connect Six · ai-worker.js
   v2.0.0 · 2026-07-05
   ============================================================
   AI 引擎：可同時在 Web Worker 與主執行緒（file:// 後備）執行。
   核心：
   - 視窗式評估（所有 6 格視窗掃描，符合六子棋威脅語意）
   - 雙子配對搜尋（以「回合」為單位的 negamax + alpha-beta）
   - 迭代加深 + 時間控制
   - 即時勝利 / 必擋偵測
   ============================================================ */

'use strict';

(function (root) {

const SIZE = 19;
const CELLS = SIZE * SIZE;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const WIN_SCORE = 1e9;
const TIMEOUT = Symbol('timeout');

// 6 格視窗中含 k 顆己方棋（無敵方棋）的價值
const WT = [0, 2, 16, 120, 1000, 12000, 100000000];
// 單點增益表（落子後視窗由 k-1 顆變 k 顆的價值）
const PS = [0, 3, 24, 180, 1400, 20000, 1000000];

// 段數 → 搜尋參數。noise 擾亂候選排序、blunder 為放水機率
const LEVEL_CONF = {
    1: {depth: 1, cells: 6,  pairs: 5,  noise: 600, blunder: 0.35},
    2: {depth: 1, cells: 8,  pairs: 8,  noise: 300, blunder: 0.22},
    3: {depth: 1, cells: 10, pairs: 12, noise: 150, blunder: 0.10},
    4: {depth: 2, cells: 10, pairs: 12, noise: 60,  blunder: 0.05},
    5: {depth: 2, cells: 12, pairs: 16, noise: 0,   blunder: 0},
    6: {depth: 2, cells: 14, pairs: 20, noise: 0,   blunder: 0},
    7: {depth: 3, cells: 14, pairs: 20, noise: 0,   blunder: 0},
    8: {depth: 3, cells: 16, pairs: 26, noise: 0,   blunder: 0},
    9: {depth: 4, cells: 18, pairs: 32, noise: 0,   blunder: 0}
};

// 預先建好所有長度 >= 6 的線（水平、垂直、兩斜向）
const LINES = (() => {
    const lines = [];
    for (let r = 0; r < SIZE; r++) {
        const h = [], v = [];
        for (let c = 0; c < SIZE; c++) {
            h.push(r * SIZE + c);
            v.push(c * SIZE + r);
        }
        lines.push(h, v);
    }
    for (let k = -(SIZE - 1); k <= SIZE - 1; k++) {
        const d = [];
        for (let r = 0; r < SIZE; r++) {
            const c = r - k;
            if (c >= 0 && c < SIZE) d.push(r * SIZE + c);
        }
        if (d.length >= 6) lines.push(d);
    }
    for (let k = 0; k <= 2 * (SIZE - 1); k++) {
        const d = [];
        for (let r = 0; r < SIZE; r++) {
            const c = k - r;
            if (c >= 0 && c < SIZE) d.push(r * SIZE + c);
        }
        if (d.length >= 6) lines.push(d);
    }
    return lines;
})();

function flatten(board2d) {
    const b = new Int8Array(CELLS);
    for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++)
            b[r * SIZE + c] = board2d[r][c];
    return b;
}

function toRC(i) {
    return {r: (i / SIZE) | 0, c: i % SIZE};
}

/**
 * 全盤視窗掃描：雙方分數與威脅視窗數
 * 威脅視窗 = 6 格內含 >=4 顆己方棋且無敵方棋（對手必須回應）
 */
function scan(b) {
    let sB = 0, sW = 0, tB = 0, tW = 0;
    for (const line of LINES) {
        let nB = 0, nW = 0;
        const len = line.length;
        for (let i = 0; i < len; i++) {
            const v = b[line[i]];
            if (v === 1) nB++; else if (v === 2) nW++;
            if (i >= 6) {
                const u = b[line[i - 6]];
                if (u === 1) nB--; else if (u === 2) nW--;
            }
            if (i >= 5) {
                if (nW === 0 && nB > 0) { sB += WT[nB]; if (nB >= 4) tB++; }
                else if (nB === 0 && nW > 0) { sW += WT[nW]; if (nW >= 4) tW++; }
            }
        }
    }
    return {sB, sW, tB, tW};
}

function threatCount(b, color) {
    const s = scan(b);
    return color === 1 ? s.tB : s.tW;
}

/**
 * 靜態評估（視角 = me，且 me 為下一個落子方）
 */
function staticEval(b, me) {
    const {sB, sW, tB, tW} = scan(b);
    const myS = me === 1 ? sB : sW, opS = me === 1 ? sW : sB;
    const myT = me === 1 ? tB : tW, opT = me === 1 ? tW : tB;
    let sc = myS - opS;
    if (myT > 0) sc += 40000 + myT * 8000;
    sc -= opT > 2 ? 100000 + opT * 8000 : opT * 12000;
    return sc;
}

/**
 * 單點增益：在 i 落 color 子，所有通過該點且無敵方棋的視窗價值增量
 * （呼叫時 b[i] 必須為空，函式內部暫放暫收）
 */
function gainScore(b, i, color) {
    const r = (i / SIZE) | 0, c = i % SIZE;
    const opp = 3 - color;
    let s = 0;
    b[i] = color;
    for (const [dr, dc] of DIRS) {
        for (let off = -5; off <= 0; off++) {
            let mine = 0, other = 0, ok = true;
            for (let k = 0; k < 6; k++) {
                const rr = r + dr * (off + k), cc = c + dc * (off + k);
                if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) { ok = false; break; }
                const v = b[rr * SIZE + cc];
                if (v === color) mine++;
                else if (v === opp) other++;
            }
            if (!ok || other > 0) continue;
            s += PS[mine] - PS[mine - 1];
        }
    }
    b[i] = 0;
    return s;
}

/**
 * 檢查 i 落子後的勝負（鏡射 game.js 的 checkWin 順序與長連規則）
 * 回傳 'win' | 'overline' | null（呼叫時 b[i] 已放好棋）
 */
function winKindAt(b, i, color) {
    const r = (i / SIZE) | 0, c = i % SIZE;
    for (const [dr, dc] of DIRS) {
        let count = 1;
        for (let k = 1; k < SIZE; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) break;
            if (b[rr * SIZE + cc] !== color) break;
            count++;
        }
        for (let k = 1; k < SIZE; k++) {
            const rr = r - dr * k, cc = c - dc * k;
            if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) break;
            if (b[rr * SIZE + cc] !== color) break;
            count++;
        }
        if (count >= 6) return count >= 7 ? 'overline' : 'win';
    }
    return null;
}

/**
 * 有棋子的鄰域（切比雪夫距離 2 內）空點
 */
function nearEmpty(b) {
    const mask = new Uint8Array(CELLS);
    let has = false;
    for (let i = 0; i < CELLS; i++) {
        if (!b[i]) continue;
        has = true;
        const r = (i / SIZE) | 0, c = i % SIZE;
        for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr >= 0 && rr < SIZE && cc >= 0 && cc < SIZE) {
                    const j = rr * SIZE + cc;
                    if (!b[j]) mask[j] = 1;
                }
            }
        }
    }
    if (!has) return [9 * SIZE + 9];
    const out = [];
    for (let i = 0; i < CELLS; i++) if (mask[i]) out.push(i);
    return out;
}

/**
 * 一子即勝的點
 */
function findWin1(b, color, cells) {
    const out = [];
    for (const i of cells) {
        b[i] = color;
        if (winKindAt(b, i, color) === 'win') out.push(i);
        b[i] = 0;
    }
    return out;
}

/**
 * 本回合 2 子內獲勝的組合（回傳 [i1, i2] 或 null）
 */
function findWinPair(b, color, cells) {
    const w1 = findWin1(b, color, cells);
    if (w1.length > 0) {
        const w = w1[0];
        let other = -1, bestS = -Infinity;
        for (const i of cells) {
            if (i === w) continue;
            const s = gainScore(b, i, color);
            if (s > bestS) { bestS = s; other = i; }
        }
        return other >= 0 ? [w, other] : [w];
    }
    // 兩子合力連六（4+2 / 5 隔一 +1 等）：只試攻擊分最高的點
    const scored = cells.map(i => ({i, s: gainScore(b, i, color)}));
    scored.sort((a, b2) => b2.s - a.s);
    const top = scored.slice(0, 24);
    for (const {i} of top) {
        b[i] = color;
        for (const j of cells) {
            if (j === i) continue;
            b[j] = color;
            const win = winKindAt(b, j, color) === 'win' || winKindAt(b, i, color) === 'win';
            b[j] = 0;
            if (win) { b[i] = 0; return [i, j]; }
        }
        b[i] = 0;
    }
    return null;
}

/**
 * 產生本回合的雙子候選組合
 */
function genPairs(b, color, conf, noise) {
    const cells = nearEmpty(b);
    const opp = 3 - color;
    const scored = cells.map(i => {
        const s = gainScore(b, i, color) + gainScore(b, i, opp) * 0.9 +
                  (noise ? Math.random() * noise : 0);
        return {i, s};
    });
    scored.sort((a, b2) => b2.s - a.s);
    const top = scored.slice(0, conf.cells);

    const pairs = [];
    for (let x = 0; x < top.length; x++) {
        for (let y = x + 1; y < top.length; y++) {
            pairs.push({a: top[x].i, b: top[y].i, s: top[x].s + top[y].s});
        }
    }
    pairs.sort((p, q) => q.s - p.s);
    const kept = pairs.slice(0, conf.pairs);

    // 精算：第二子在第一子放下後的實際增益（抓兩子同線的合力）
    for (const p of kept) {
        b[p.a] = color;
        p.s = p.s * 0.4 + gainScore(b, p.b, color) + gainScore(b, p.b, opp) * 0.9;
        b[p.a] = 0;
    }
    kept.sort((p, q) => q.s - p.s);
    return kept;
}

/**
 * Negamax + alpha-beta，一層 = 一個回合（2 子）
 */
function negamax(b, color, depth, alpha, beta, ply, deadline, stats, conf) {
    if ((++stats.nodes & 255) === 0 && Date.now() > deadline) throw TIMEOUT;

    const cells = nearEmpty(b);
    // 輪到走的一方一子即勝（有 2 子可下，必勝）
    if (findWin1(b, color, cells).length > 0) return WIN_SCORE - ply;
    if (depth <= 0) return staticEval(b, color);

    const pairs = genPairs(b, color, conf, 0);
    if (pairs.length === 0) return staticEval(b, color);

    let best = -Infinity;
    for (const p of pairs) {
        b[p.a] = color; b[p.b] = color;
        let val;
        if (winKindAt(b, p.a, color) === 'win' || winKindAt(b, p.b, color) === 'win') {
            val = WIN_SCORE - ply;
        } else {
            val = -negamax(b, 3 - color, depth - 1, -beta, -alpha, ply + 1, deadline, stats, conf);
        }
        b[p.a] = 0; b[p.b] = 0;

        if (val > best) best = val;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
    }
    return best;
}

/**
 * 主入口
 * @returns {moves:[{r,c}...], flags:{win,threat,blocked,danger}, stats:{depth,nodes,ms}}
 */
function chooseMoves(board2d, turn, movesNeeded, level, timeLimit) {
    const t0 = Date.now();
    const b = flatten(board2d);
    const conf = LEVEL_CONF[level] || LEVEL_CONF[6];
    const budget = timeLimit > 0 ? timeLimit : 10000;
    const deadline = t0 + Math.max(300, budget - 100);
    const me = turn, opp = 3 - turn;
    const stats = {depth: 0, nodes: 0, ms: 0};
    const done = (moves, flags) => {
        stats.ms = Date.now() - t0;
        return {moves, flags: flags || {}, stats};
    };

    const cells = nearEmpty(b);

    // 只需 1 子（開局黑先手，或提示模式下的半回合）
    if (movesNeeded === 1) {
        if (board2d.every(row => row.every(v => v === 0))) {
            return done([{r: 9, c: 9}]);
        }
        const w1 = findWin1(b, me, cells);
        if (w1.length > 0) return done([toRC(w1[0])], {win: true});
        const oppW = findWin1(b, opp, cells);
        if (oppW.length > 0) return done([toRC(oppW[0])], {blocked: true});
        let bi = cells[0], bs = -Infinity;
        for (const i of cells) {
            const s = gainScore(b, i, me) + gainScore(b, i, opp) * 0.9;
            if (s > bs) { bs = s; bi = i; }
        }
        return done([toRC(bi)]);
    }

    const oppW1 = findWin1(b, opp, cells);
    const beforeOppTh = threatCount(b, opp);
    const beforeMyTh = threatCount(b, me);

    // 1. 本回合直接獲勝
    const wp = findWinPair(b, me, cells);
    if (wp) return done(wp.map(toRC), {win: true, danger: beforeOppTh > 0});

    // 2. 低段放水：跳過搜尋、不保證防守
    if (conf.blunder > 0 && Math.random() < conf.blunder) {
        const sloppy = genPairs(b, me, conf, conf.noise * 2);
        const pick = sloppy[Math.min(sloppy.length - 1, 1 + ((Math.random() * 3) | 0))];
        if (pick) return done([toRC(pick.a), toRC(pick.b)]);
    }

    // 3. 迭代加深搜尋
    const rootPairs = genPairs(b, me, conf, conf.noise);
    let best = null;
    for (let d = 1; d <= conf.depth; d++) {
        let iterBest = null, alpha = -Infinity;
        try {
            for (const p of rootPairs) {
                b[p.a] = me; b[p.b] = me;
                let val;
                if (winKindAt(b, p.a, me) === 'win' || winKindAt(b, p.b, me) === 'win') {
                    val = WIN_SCORE;
                } else {
                    val = -negamax(b, opp, d - 1, -Infinity, -alpha, 1, deadline, stats, conf);
                }
                b[p.a] = 0; b[p.b] = 0;
                p.val = val;
                if (val > alpha) { alpha = val; iterBest = p; }
            }
        } catch (e) {
            if (e !== TIMEOUT) throw e;
            break; // 逾時：沿用上一層完整結果
        }
        if (iterBest) { best = iterBest; stats.depth = d; }
        rootPairs.sort((p, q) => (q.val || -Infinity) - (p.val || -Infinity));
        if (alpha >= WIN_SCORE - 64) break;
        if (Date.now() > deadline) break;
    }
    if (!best) best = rootPairs[0];

    // 4. 對話旗標
    b[best.a] = me; b[best.b] = me;
    const afterMyTh = threatCount(b, me);
    const afterOppW1 = findWin1(b, opp, nearEmpty(b));
    b[best.a] = 0; b[best.b] = 0;

    const flags = {
        threat: afterMyTh > beforeMyTh && afterMyTh > 0,
        blocked: oppW1.length > 0 && afterOppW1.length === 0,
        danger: beforeOppTh > 0
    };
    return done([toRC(best.a), toRC(best.b)], flags);
}

/**
 * 快速威脅計數（主執行緒判斷玩家是否下出好棋用）
 */
function quickThreats(board2d, color) {
    return threatCount(flatten(board2d), color);
}

const AIEngine = {chooseMoves, quickThreats};
root.AIEngine = AIEngine;

// Worker 環境：註冊訊息處理
if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = (e) => {
        const d = e.data;
        if (d && d.type === 'move') {
            const result = chooseMoves(d.board, d.turn, d.movesNeeded, d.level, d.timeLimit);
            self.postMessage({type: 'result', reqId: d.reqId, moves: result.moves, flags: result.flags, stats: result.stats});
        }
    };
}

})(typeof self !== 'undefined' ? self : this);
