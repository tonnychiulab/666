/* ============================================================
   六子棋 Connect Six · game.js
   v2.0.0 · 2026-07-05
   ============================================================
   檔案結構：
   1. 常數 & 設定
   2. 全域狀態
   3. 棋盤邏輯 (Board Logic)
   4. SVG 渲染引擎 (SVG Renderer)
   5. AI 連線層 (AI Client · 引擎在 ai-worker.js)
   6. 童磨對話系統 (Douma)
   7. 場景管理器 (Scene Manager)
   8. 遊戲控制 (Game Flow)
   9. UI 互動 (UI Interaction)
   10. 音效 / 煙火 / Toast
   11. 載入初始化
   ============================================================ */

'use strict';

/* ============================================================
   1. 常數 & 設定
   ============================================================ */
const VERSION = '2.0.0';
const BOARD_SIZE = 19;
const SVG_SIZE = 760;
const PADDING = 30;
const CELL = (SVG_SIZE - 2 * PADDING) / (BOARD_SIZE - 1);
const STONE_R = CELL * 0.42;

// 標準圍棋星位
const STAR_POSITIONS = [
    [3,3],[3,9],[3,15],
    [9,3],      [9,15],
    [15,3],[15,9],[15,15]
];

const COLS = 'ABCDEFGHJKLMNOPQRST'; // 跳過 I

const DIRECTIONS = [
    [0, 1],   // 水平
    [1, 0],   // 垂直
    [1, 1],   // 斜 ↘
    [1, -1]   // 斜 ↙
];

const WIN_COUNT = 6;
const OVERLINE = 7; // 七連以上算和局

/* ============================================================
   2. 全域狀態
   ============================================================ */
const G = {
    // 遊戲狀態
    board: [],              // 0=空 1=黑 2=白
    currentTurn: 1,         // 1=黑 2=白
    stonesToPlace: 1,       // 本回合還要下幾子
    moveHistory: [],        // [{r,c,turn,moveNum}]
    gameStarted: false,
    gameOver: false,
    winner: 0,              // 0=進行中 1=黑勝 2=白勝 3=和局
    winLine: null,          // {r1,c1,r2,c2}
    resigned: false,

    // 設定
    mode: 'ai',             // 'ai' | 'pvp'
    playerColor: 1,         // 玩家執黑(1)或白(2)
    aiLevel: 6,             // AI 段位 1~9
    thinkTime: 3000,        // AI 思考時間
    showCoordinates: true,
    showMoveNumbers: true,
    soundEnabled: false,

    // 場景
    scene: 'inn',

    // 計時
    startTime: 0,
    timerId: null,

    // AI
    aiThinking: false,
    hintBusy: false,

    // SVG
    svg: null,
    svgNs: 'http://www.w3.org/2000/svg',
    boardGroup: null,
    stonesGroup: null,
    hoverGroup: null,
    winGroup: null
};

/* ============================================================
   3. 棋盤邏輯 (Board Logic)
   ============================================================ */
const Board = {
    init() {
        G.board = Array.from({length: BOARD_SIZE}, () => new Array(BOARD_SIZE).fill(0));
        G.currentTurn = 1;
        G.stonesToPlace = 1; // 黑先手只下1子
        G.moveHistory = [];
        G.gameStarted = true;
        G.gameOver = false;
        G.winner = 0;
        G.winLine = null;
    },

    inBounds(r, c) {
        return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
    },

    place(r, c) {
        if (!Board.inBounds(r, c)) return false;
        if (G.board[r][c] !== 0) return false;
        if (G.gameOver) return false;

        const turn = G.currentTurn;
        G.board[r][c] = turn;

        const moveNum = G.moveHistory.length + 1;
        G.moveHistory.push({r, c, turn, moveNum});

        G.stonesToPlace--;

        // 每落一子就檢查勝負（第一子連六也立即獲勝）
        const result = Board.checkWin(r, c, turn);
        if (result.win) {
            G.gameOver = true;
            G.winner = result.overline ? 3 : turn;
            G.winLine = result.line;
        } else if (G.stonesToPlace === 0) {
            G.currentTurn = (turn === 1) ? 2 : 1;
            G.stonesToPlace = 2; // 六子棋每回合下2子
        }

        return true;
    },

    /**
     * 由已落子總數推算回合狀態
     * 序列：黑1子 → 白2子 → 黑2子 → 白2子 → …
     */
    computeTurnState(total) {
        if (total === 0) return {turn: 1, toPlace: 1};
        const k = total - 1;
        const pairIdx = (k % 2 === 0) ? k / 2 : (k - 1) / 2;
        const turn = pairIdx % 2 === 0 ? 2 : 1;
        return {turn, toPlace: k % 2 === 0 ? 2 : 1};
    },

    undoLast() {
        if (G.moveHistory.length === 0) return false;

        const undoCount = Math.min(2, G.moveHistory.length);
        for (let i = 0; i < undoCount; i++) {
            const m = G.moveHistory.pop();
            G.board[m.r][m.c] = 0;
        }

        const state = Board.computeTurnState(G.moveHistory.length);
        G.currentTurn = state.turn;
        G.stonesToPlace = state.toPlace;

        G.gameOver = false;
        G.winner = 0;
        G.winLine = null;
        return true;
    },

    /**
     * 檢查勝負
     * 回傳 { win: boolean, overline: boolean, line: {r1,c1,r2,c2} }
     */
    checkWin(r, c, turn) {
        for (const [dr, dc] of DIRECTIONS) {
            let count = 1;
            let endR = r, endC = c;
            let startR = r, startC = c;

            for (let i = 1; i < BOARD_SIZE; i++) {
                const nr = r + dr * i, nc = c + dc * i;
                if (!Board.inBounds(nr, nc)) break;
                if (G.board[nr][nc] !== turn) break;
                count++;
                endR = nr; endC = nc;
            }

            for (let i = 1; i < BOARD_SIZE; i++) {
                const nr = r - dr * i, nc = c - dc * i;
                if (!Board.inBounds(nr, nc)) break;
                if (G.board[nr][nc] !== turn) break;
                count++;
                startR = nr; startC = nc;
            }

            if (count >= WIN_COUNT) {
                const overline = count >= OVERLINE;
                return {
                    win: true,
                    overline,
                    line: {r1: startR, c1: startC, r2: endR, c2: endC}
                };
            }
        }

        // 棋盤滿了？
        let full = true;
        for (let i = 0; i < BOARD_SIZE; i++) {
            for (let j = 0; j < BOARD_SIZE; j++) {
                if (G.board[i][j] === 0) { full = false; break; }
            }
            if (!full) break;
        }
        if (full) return {win: true, overline: true, line: null, draw: true};

        return {win: false};
    },

    toCoord(r, c) {
        return COLS[c] + (BOARD_SIZE - r);
    }
};

/* ============================================================
   4. SVG 渲染引擎 (SVG Renderer)
   ============================================================ */
const Renderer = {
    init() {
        G.svg = document.getElementById('boardSvg');
        G.svg.innerHTML = '';

        // defs：漸層、濾鏡
        const defs = document.createElementNS(G.svgNs, 'defs');
        defs.innerHTML = `
            <filter id="stoneShadow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur in="SourceAlpha" stdDeviation="1.5"/>
                <feOffset dx="1" dy="2" result="offsetblur"/>
                <feComponentTransfer><feFuncA type="linear" slope="0.45"/></feComponentTransfer>
                <feMerge>
                    <feMergeNode/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
            <radialGradient id="blackStone" cx="30%" cy="25%" r="70%">
                <stop offset="0%" stop-color="#666"/>
                <stop offset="50%" stop-color="#222"/>
                <stop offset="100%" stop-color="#0a0a0a"/>
            </radialGradient>
            <radialGradient id="whiteStone" cx="30%" cy="25%" r="70%">
                <stop offset="0%" stop-color="#fff"/>
                <stop offset="50%" stop-color="#eee"/>
                <stop offset="100%" stop-color="#c8c8c8"/>
            </radialGradient>
        `;
        G.svg.appendChild(defs);

        // 棋盤背景
        const bgRect = document.createElementNS(G.svgNs, 'rect');
        bgRect.setAttribute('class', 'board-rect');
        bgRect.setAttribute('x', 5);
        bgRect.setAttribute('y', 5);
        bgRect.setAttribute('width', SVG_SIZE - 10);
        bgRect.setAttribute('height', SVG_SIZE - 10);
        bgRect.setAttribute('rx', 6);
        G.svg.appendChild(bgRect);

        // 網格群組
        const gridGroup = document.createElementNS(G.svgNs, 'g');
        gridGroup.setAttribute('class', 'grid-group');

        for (let i = 0; i < BOARD_SIZE; i++) {
            const hLine = document.createElementNS(G.svgNs, 'line');
            hLine.setAttribute('class', 'board-line');
            hLine.setAttribute('x1', PADDING);
            hLine.setAttribute('y1', PADDING + i * CELL);
            hLine.setAttribute('x2', SVG_SIZE - PADDING);
            hLine.setAttribute('y2', PADDING + i * CELL);
            gridGroup.appendChild(hLine);

            const vLine = document.createElementNS(G.svgNs, 'line');
            vLine.setAttribute('class', 'board-line');
            vLine.setAttribute('x1', PADDING + i * CELL);
            vLine.setAttribute('y1', PADDING);
            vLine.setAttribute('x2', PADDING + i * CELL);
            vLine.setAttribute('y2', SVG_SIZE - PADDING);
            gridGroup.appendChild(vLine);
        }

        // 星位
        STAR_POSITIONS.forEach(([r, c]) => {
            const star = document.createElementNS(G.svgNs, 'circle');
            star.setAttribute('class', 'board-star');
            star.setAttribute('cx', PADDING + c * CELL);
            star.setAttribute('cy', PADDING + r * CELL);
            star.setAttribute('r', 3.5);
            gridGroup.appendChild(star);
        });

        // 座標文字
        if (G.showCoordinates) {
            for (let i = 0; i < BOARD_SIZE; i++) {
                const topText = document.createElementNS(G.svgNs, 'text');
                topText.setAttribute('class', 'coord-text');
                topText.setAttribute('x', PADDING + i * CELL);
                topText.setAttribute('y', PADDING - 10);
                topText.setAttribute('text-anchor', 'middle');
                topText.textContent = COLS[i];
                gridGroup.appendChild(topText);

                const leftText = document.createElementNS(G.svgNs, 'text');
                leftText.setAttribute('class', 'coord-text');
                leftText.setAttribute('x', PADDING - 14);
                leftText.setAttribute('y', PADDING + i * CELL + 4);
                leftText.setAttribute('text-anchor', 'middle');
                leftText.textContent = BOARD_SIZE - i;
                gridGroup.appendChild(leftText);
            }
        }

        G.svg.appendChild(gridGroup);
        G.boardGroup = gridGroup;

        // 棋子群組
        G.stonesGroup = document.createElementNS(G.svgNs, 'g');
        G.stonesGroup.setAttribute('class', 'stones-group');
        G.svg.appendChild(G.stonesGroup);

        // hover 預覽群組
        G.hoverGroup = document.createElementNS(G.svgNs, 'g');
        G.hoverGroup.setAttribute('class', 'hover-group');
        G.svg.appendChild(G.hoverGroup);

        // 勝利連線群組
        G.winGroup = document.createElementNS(G.svgNs, 'g');
        G.winGroup.setAttribute('class', 'win-group');
        G.svg.appendChild(G.winGroup);

        G.svg.addEventListener('click', Renderer.onClick);
        G.svg.addEventListener('mousemove', Renderer.onMouseMove);
        G.svg.addEventListener('mouseleave', () => Renderer.clearHover());
    },

    px(r, c) {
        return {
            x: PADDING + c * CELL,
            y: PADDING + r * CELL
        };
    },

    reversePx(x, y) {
        const rect = G.svg.getBoundingClientRect();
        const scaleX = SVG_SIZE / rect.width;
        const scaleY = SVG_SIZE / rect.height;
        const svgX = (x - rect.left) * scaleX;
        const svgY = (y - rect.top) * scaleY;

        const c = Math.round((svgX - PADDING) / CELL);
        const r = Math.round((svgY - PADDING) / CELL);
        return {r, c};
    },

    onClick(e) {
        if (!G.gameStarted || G.gameOver || G.aiThinking) return;
        if (G.mode === 'ai' && G.currentTurn !== G.playerColor) return;

        const {r, c} = Renderer.reversePx(e.clientX, e.clientY);
        if (!Board.inBounds(r, c)) return;
        if (G.board[r][c] !== 0) return;

        Game.placeStone(r, c);
    },

    onMouseMove(e) {
        if (!G.gameStarted || G.gameOver || G.aiThinking) return;
        if (G.mode === 'ai' && G.currentTurn !== G.playerColor) return;
        if (G.stonesToPlace === 0) return;

        const {r, c} = Renderer.reversePx(e.clientX, e.clientY);
        Renderer.clearHover();
        if (Board.inBounds(r, c) && G.board[r][c] === 0) {
            Renderer.drawHover(r, c, G.currentTurn);
        }
    },

    drawHover(r, c, turn) {
        const {x, y} = Renderer.px(r, c);
        const ghost = document.createElementNS(G.svgNs, 'circle');
        ghost.setAttribute('class', 'hover-ghost');
        ghost.setAttribute('cx', x);
        ghost.setAttribute('cy', y);
        ghost.setAttribute('r', STONE_R);
        ghost.setAttribute('fill', turn === 1 ? 'url(#blackStone)' : 'url(#whiteStone)');
        G.hoverGroup.appendChild(ghost);
    },

    clearHover() {
        if (G.hoverGroup) G.hoverGroup.innerHTML = '';
    },

    drawStone(r, c, turn, moveNum) {
        const {x, y} = Renderer.px(r, c);
        const g = document.createElementNS(G.svgNs, 'g');
        g.setAttribute('class', `stone-group stone-${turn === 1 ? 'black' : 'white'}`);
        g.setAttribute('data-r', r);
        g.setAttribute('data-c', c);

        const shadow = document.createElementNS(G.svgNs, 'ellipse');
        shadow.setAttribute('class', 'stone-shadow');
        shadow.setAttribute('cx', x + 1.5);
        shadow.setAttribute('cy', y + 2.5);
        shadow.setAttribute('rx', STONE_R * 0.85);
        shadow.setAttribute('ry', STONE_R * 0.75);
        g.appendChild(shadow);

        const circle = document.createElementNS(G.svgNs, 'circle');
        circle.setAttribute('class', 'stone-circle');
        circle.setAttribute('cx', x);
        circle.setAttribute('cy', y);
        circle.setAttribute('r', 0); // 動畫起點
        circle.setAttribute('fill', turn === 1 ? 'url(#blackStone)' : 'url(#whiteStone)');
        circle.setAttribute('filter', 'url(#stoneShadow)');
        g.appendChild(circle);

        if (G.showMoveNumbers && moveNum !== undefined) {
            const text = document.createElementNS(G.svgNs, 'text');
            text.setAttribute('class', 'stone-num');
            text.setAttribute('x', x);
            text.setAttribute('y', y);
            text.textContent = moveNum;
            g.appendChild(text);
        }

        G.stonesGroup.appendChild(g);

        // 落子動畫
        let cur = 0;
        const animId = setInterval(() => {
            cur += 2;
            if (cur >= STONE_R) {
                circle.setAttribute('r', STONE_R);
                clearInterval(animId);
            } else {
                circle.setAttribute('r', cur);
            }
        }, 12);

        return g;
    },

    removeStone(r, c) {
        const stones = G.stonesGroup.querySelectorAll('.stone-group');
        stones.forEach(s => {
            const sr = parseInt(s.dataset.r);
            const sc = parseInt(s.dataset.c);
            if (sr === r && sc === c) s.remove();
        });
    },

    redrawAll() {
        G.stonesGroup.innerHTML = '';
        G.moveHistory.forEach(m => {
            Renderer.drawStone(m.r, m.c, m.turn, m.moveNum);
        });
    },

    drawWinLine() {
        if (!G.winLine) return;
        const p1 = Renderer.px(G.winLine.r1, G.winLine.c1);
        const p2 = Renderer.px(G.winLine.r2, G.winLine.c2);

        const line = document.createElementNS(G.svgNs, 'line');
        line.setAttribute('class', 'win-line');
        line.setAttribute('x1', p1.x);
        line.setAttribute('y1', p1.y);
        line.setAttribute('x2', p2.x);
        line.setAttribute('y2', p2.y);
        line.setAttribute('stroke-dasharray', '500');
        line.setAttribute('stroke-dashoffset', '500');
        G.winGroup.appendChild(line);
    },

    clearWinLine() {
        if (G.winGroup) G.winGroup.innerHTML = '';
    },

    clearAll() {
        G.stonesGroup.innerHTML = '';
        G.hoverGroup.innerHTML = '';
        G.winGroup.innerHTML = '';
    }
};

/* ============================================================
   5. AI 連線層 (AI Client)
   引擎本體在 ai-worker.js。優先走 Web Worker；
   file:// 或 Worker 失效時退回主執行緒同步運算。
   ============================================================ */
const AIClient = {
    worker: null,
    reqSeq: 0,
    pending: new Map(),

    init() {
        if (location.protocol === 'file:') return; // file:// 無法建 Worker
        try {
            const w = new Worker('ai-worker.js');
            w.onmessage = (e) => {
                const p = AIClient.pending.get(e.data.reqId);
                if (p) {
                    AIClient.pending.delete(e.data.reqId);
                    p.resolve(e.data);
                }
            };
            w.onerror = () => {
                console.warn('AI Worker 失效，改用主執行緒運算');
                AIClient.worker = null;
                AIClient.pending.forEach(p => p.reject(new Error('worker error')));
                AIClient.pending.clear();
            };
            AIClient.worker = w;
        } catch (e) {
            AIClient.worker = null;
        }
    },

    request(payload) {
        if (AIClient.worker) {
            return new Promise((resolve, reject) => {
                const reqId = ++AIClient.reqSeq;
                AIClient.pending.set(reqId, {resolve, reject});
                AIClient.worker.postMessage({type: 'move', reqId, ...payload});
            }).catch(() => AIClient.localCompute(payload));
        }
        return AIClient.localCompute(payload);
    },

    localCompute(payload) {
        return new Promise(resolve => {
            setTimeout(() => {
                resolve(AIEngine.chooseMoves(
                    payload.board, payload.turn, payload.movesNeeded,
                    payload.level, payload.timeLimit
                ));
            }, 30);
        });
    }
};

/* ============================================================
   6. 童磨對話系統 (Douma)
   上弦之貳風格：永遠微笑、假慈悲、把殘酷說得溫柔
   ============================================================ */
const Douma = {
    el: null,
    textEl: null,
    bubbleEl: null,
    lastLine: '',

    LINES: {
        opening: [
            '歡迎歡迎～來，坐。人類的一生那麼短，就用這盤棋讓我替你超渡吧。',
            '哎呀，又有可愛的人類來挑戰了。放輕鬆，痛苦很快就會結束的。',
            '來玩吧。我可是很溫柔的哦，會讓你輸得心服口服。',
            '棋盤就是小小的世界呢。來，讓我看看人類掙扎的樣子吧。'
        ],
        threat: [
            '看，絕望正一格一格地靠近你哦。想哭出來也沒關係的。',
            '這裡，還有這裡。你擋得住哪一邊呢？真令人期待呀。',
            '不用急著回應沒關係，反正結局早就決定了。',
            '感覺到了嗎？棋盤在替你倒數哦。'
        ],
        block: [
            '想這樣贏我嗎？好可憐哪，我都替你感到難過了。',
            '嗯～不錯的攻擊。可惜，在我眼裡全都一清二楚。',
            '哎呀哎呀，就差一點呢。就差那麼一點點哦？',
            '這步棋很努力了。人類的努力，總是讓我微笑。'
        ],
        praise: [
            '哦？這步棋挺有靈性的嘛。人類偶爾也會發光呢。',
            '好棋！要是你早生個幾百年，說不定能讓我認真三秒鐘。',
            '有點意思了。來，再讓我看看人類的極限吧。'
        ],
        idle: [
            '下棋的時候，人類的表情最有趣了。',
            '慢慢想沒關係哦，我有的是時間。你可沒有。',
            '這麼安靜，是在害怕嗎？沒關係，害怕是正常的。'
        ],
        win: [
            '別難過嘛。輸給我不是你的錯，誰叫你只是人類呢。',
            '啊……結束了。別哭別哭，這就是實力的差距呀。',
            '好啦好啦，安息吧。下輩子再努力就好了嘛。'
        ],
        lose: [
            '咦……？我、輸了？哈哈、哈哈哈！有趣！你這人類真是有趣！',
            '這不可能……不過，能敗在你手上，也算是一種幸福……吧？'
        ],
        draw: [
            '和局？哎呀，連老天爺都不忍心看你輸呢。',
            '打成平手了呀。要不要再來一局，讓我好好送你一程？'
        ],
        resign: [
            '投降了嗎？嗯嗯，懂得放棄也是一種智慧哦。',
            '這麼快就結束了？人類真是脆弱得惹人憐愛呢。'
        ]
    },

    init() {
        Douma.el = document.getElementById('doumaBar');
        Douma.textEl = document.getElementById('doumaText');
        Douma.bubbleEl = Douma.el.querySelector('.douma-bubble');
    },

    show() { Douma.el.hidden = false; },
    hide() { Douma.el.hidden = true; },

    say(cat) {
        if (!Douma.el || Douma.el.hidden) return;
        const pool = Douma.LINES[cat];
        if (!pool) return;
        let line = pool[(Math.random() * pool.length) | 0];
        if (pool.length > 1 && line === Douma.lastLine) {
            line = pool[(pool.indexOf(line) + 1) % pool.length];
        }
        Douma.lastLine = line;
        Douma.textEl.textContent = line;
        Douma.bubbleEl.classList.remove('pop');
        void Douma.bubbleEl.offsetWidth;
        Douma.bubbleEl.classList.add('pop');
    },

    // AI 落子後依引擎旗標挑話
    react(flags) {
        if (!flags) {
            if (Math.random() < 0.2) Douma.say('idle');
            return;
        }
        if (flags.win) return; // 勝負台詞由 onGameEnd 處理
        if (flags.threat) Douma.say('threat');
        else if (flags.blocked) Douma.say('block');
        else if (flags.danger && Math.random() < 0.6) Douma.say('praise');
        else if (Math.random() < 0.25) Douma.say('idle');
    }
};

/* ============================================================
   7. 場景管理器 (Scene Manager)
   ============================================================ */
const SceneManager = {
    scenes: {
        inn: {
            name: '客棧',
            icon: '🏮',
            decorations: [
                { tag: 'rect', x: -20, y: 0, w: '120%', h: '15%', fill: 'rgba(120,60,20,0.6)' },
                { tag: 'circle', cx: '50%', cy: '12%', r: 20, fill: 'rgba(212,160,76,0.2)' }
            ]
        },
        tea: {
            name: '泡沫紅茶',
            icon: '🧋',
            decorations: [
                { tag: 'rect', x: 0, y: '85%', w: '100%', h: '15%', fill: 'rgba(40,20,80,0.5)' }
            ]
        },
        temple: {
            name: '廟口',
            icon: '🛕',
            decorations: [
                { tag: 'rect', x: 0, y: 0, w: '100%', h: '10%', fill: 'rgba(150,40,20,0.4)' }
            ]
        },
        park: {
            name: '公園裡',
            icon: '🌳',
            decorations: [
                { tag: 'rect', x: 0, y: 0, w: '100%', h: '20%', fill: 'rgba(20,60,30,0.4)' }
            ]
        }
    },

    apply(scene) {
        G.scene = scene;
        document.body.setAttribute('data-scene', scene);
        SceneManager.renderBackground(scene);
        const meta = SceneManager.scenes[scene];
        document.getElementById('sceneName').textContent = `${meta.icon} ${meta.name}`;
        document.querySelectorAll('.scene-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.scene === scene);
        });
    },

    renderBackground(scene) {
        const overlay = document.getElementById('sceneOverlay');
        const meta = SceneManager.scenes[scene];
        if (!overlay || !meta || !meta.decorations) return;

        const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;">` +
            meta.decorations.map(d => {
                const attrs = Object.entries(d)
                    .filter(([k]) => k !== 'tag')
                    .map(([k, v]) => `${k}="${v}"`).join(' ');
                return `<${d.tag} ${attrs}/>`;
            }).join('') + '</svg>';

        overlay.innerHTML = svgStr;

        const bg = document.getElementById('scene-bg');
        switch (scene) {
            case 'inn':
                bg.style.boxShadow = 'inset 0 0 200px rgba(60,30,10,0.5)';
                break;
            case 'tea':
                bg.style.boxShadow = 'inset 0 0 200px rgba(40,20,80,0.5)';
                break;
            case 'temple':
                bg.style.boxShadow = 'inset 0 0 200px rgba(80,20,10,0.5)';
                break;
            case 'park':
                bg.style.boxShadow = 'inset 0 0 200px rgba(10,40,20,0.5)';
                break;
        }
    }
};

/* ============================================================
   8. 遊戲控制 (Game Flow)
   ============================================================ */
const Game = {
    start() {
        // 讀取設定
        G.mode = document.querySelector('input[name="mode"]:checked').value;
        G.playerColor = document.getElementById('playerColor').value === 'black' ? 1 : 2;
        G.aiLevel = parseInt(document.getElementById('aiLevel').value);
        G.thinkTime = parseInt(document.getElementById('thinkTime').value);
        G.showCoordinates = document.getElementById('toggleCoord').checked;
        G.showMoveNumbers = document.getElementById('toggleNumber').checked;
        G.soundEnabled = document.getElementById('toggleSound').checked;
        G.resigned = false;
        G.aiThinking = false;
        G.hintBusy = false;

        // 初始化棋盤
        Board.init();
        Renderer.clearAll();
        Renderer.init();
        UI.clearMoveList();
        UI.updateTurnIndicator();
        UI.updateStonesInfo();
        UI.updateStoneCount();
        UI.updateStatus('對局進行中');
        UI.setButtons(true);

        // 啟動計時
        G.startTime = Date.now();
        if (G.timerId) clearInterval(G.timerId);
        G.timerId = setInterval(() => UI.updateTimer(), 1000);

        Toast.show('對局開始！');
        document.getElementById('winOverlay').style.display = 'none';

        // 童磨登場（僅 AI 模式）
        if (G.mode === 'ai') {
            Douma.show();
            Douma.say('opening');
        } else {
            Douma.hide();
        }

        // 若 AI 先手
        if (G.mode === 'ai' && G.playerColor === 2) {
            setTimeout(() => Game.aiMove(), 500);
        }
    },

    placeStone(r, c, byAI = false) {
        if (!G.gameStarted || G.gameOver) return false;
        if (G.aiThinking && !byAI) return false;
        if (!Board.inBounds(r, c) || G.board[r][c] !== 0) return false;

        const turn = G.currentTurn;
        Board.place(r, c);

        const moveNum = G.moveHistory[G.moveHistory.length - 1].moveNum;
        Renderer.drawStone(r, c, turn, moveNum);
        Renderer.clearHover();

        if (G.soundEnabled) Sound.play('place');

        UI.addMoveToList(r, c, turn, moveNum);
        UI.updateStonesInfo();
        UI.updateTurnIndicator();
        UI.updateStoneCount();

        if (G.gameOver) {
            Game.onGameEnd();
            return true;
        }

        // 玩家回合結束 → AI 接手
        if (G.mode === 'ai' && G.currentTurn !== G.playerColor && !G.aiThinking) {
            setTimeout(() => Game.aiMove(), 350);
        }

        return true;
    },

    aiMove() {
        if (!G.gameStarted || G.gameOver || G.aiThinking) return;
        G.aiThinking = true;
        UI.showAIThinking(true);
        UI.updateStatus('AI 思考中…');

        AIClient.request({
            board: G.board,
            turn: G.currentTurn,
            movesNeeded: G.stonesToPlace,
            level: G.aiLevel,
            timeLimit: G.thinkTime
        }).then(result => {
            UI.showAIThinking(false);
            if (G.gameOver || !G.gameStarted) { G.aiThinking = false; return; }

            const moves = (result.moves || []).filter(m =>
                Board.inBounds(m.r, m.c) && G.board[m.r][m.c] === 0);
            if (moves.length === 0) { G.aiThinking = false; return; }

            if (result.stats) {
                console.log(`AI L${G.aiLevel} depth=${result.stats.depth} nodes=${result.stats.nodes} ${result.stats.ms}ms`);
            }

            let delay = 250;
            moves.forEach((m, i) => {
                setTimeout(() => {
                    if (G.gameOver) { G.aiThinking = false; return; }
                    Game.placeStone(m.r, m.c, true);
                    if (i === moves.length - 1) {
                        G.aiThinking = false;
                        if (!G.gameOver) {
                            UI.updateStatus('對局進行中');
                            Douma.react(result.flags);
                        }
                    }
                }, delay);
                delay += 450;
            });
        }).catch(err => {
            console.error('AI 引擎錯誤', err);
            G.aiThinking = false;
            UI.showAIThinking(false);
            UI.updateStatus('對局進行中');
        });
    },

    undo() {
        if (!G.gameStarted || G.gameOver) return;
        if (G.aiThinking) {
            Toast.show('AI 思考中，請稍候');
            return;
        }
        if (!Board.undoLast()) {
            Toast.show('無法悔棋');
            return;
        }

        // AI 模式下退到玩家完整回合的起點
        if (G.mode === 'ai') {
            while (G.moveHistory.length > 0 &&
                   !(G.currentTurn === G.playerColor && G.stonesToPlace === 2)) {
                Board.undoLast();
            }
        }

        Renderer.redrawAll();
        Renderer.clearWinLine();
        UI.rebuildMoveList();
        UI.updateTurnIndicator();
        UI.updateStonesInfo();
        UI.updateStoneCount();
        Toast.show('已悔棋');
    },

    hint() {
        if (!G.gameStarted || G.gameOver || G.aiThinking || G.hintBusy) return;
        G.hintBusy = true;
        AIClient.request({
            board: G.board,
            turn: G.currentTurn,
            movesNeeded: G.stonesToPlace,
            level: 7,
            timeLimit: 1200
        }).then(res => {
            G.hintBusy = false;
            if (G.gameOver || G.aiThinking || !res.moves || res.moves.length === 0) return;
            Renderer.clearHover();
            res.moves.forEach(m => Renderer.drawHover(m.r, m.c, G.currentTurn));
            Toast.show(`💡 建議落子：${Board.toCoord(res.moves[0].r, res.moves[0].c)}`);
            setTimeout(() => Renderer.clearHover(), 2000);
        }).catch(() => { G.hintBusy = false; });
    },

    resign() {
        if (!G.gameStarted || G.gameOver) return;
        G.gameOver = true;
        G.resigned = true;
        if (G.mode === 'ai') {
            G.winner = G.playerColor === 1 ? 2 : 1;
        } else {
            G.winner = G.currentTurn === 1 ? 2 : 1;
        }
        Game.onGameEnd();
    },

    onGameEnd() {
        clearInterval(G.timerId);
        Renderer.drawWinLine();
        UI.setButtons(false, true);
        if (G.soundEnabled) Sound.play('win');

        let title, desc;
        if (G.winner === 3) {
            title = '🤝 和局！';
            desc = '長連或棋盤已滿';
        } else if (G.mode === 'ai') {
            if (G.winner === G.playerColor) {
                title = '🎉 勝利！';
                desc = `你擊敗了 ${G.aiLevel} 段 AI！`;
            } else {
                title = '😔 敗北…';
                desc = `AI（${G.aiLevel} 段）獲勝`;
            }
        } else {
            title = `🎉 ${G.winner === 1 ? '黑棋' : '白棋'} 勝利！`;
            desc = '連六取勝';
        }

        // 童磨結語
        if (G.mode === 'ai') {
            if (G.winner === 3) Douma.say('draw');
            else if (G.winner === G.playerColor) Douma.say('lose');
            else Douma.say(G.resigned ? 'resign' : 'win');
        }

        UI.showWinOverlay(title, desc);
        UI.updateStatus(G.winner === 3 ? '和局' : (G.winner === 1 ? '黑棋勝' : '白棋勝'));

        Game.saveRecord();
    },

    saveRecord() {
        try {
            const record = {
                date: new Date().toISOString(),
                version: VERSION,
                mode: G.mode,
                winner: G.winner,
                moves: G.moveHistory,
                scene: G.scene
            };
            const records = JSON.parse(localStorage.getItem('cs6_records') || '[]');
            records.push(record);
            if (records.length > 100) records.shift();
            localStorage.setItem('cs6_records', JSON.stringify(records));
        } catch (e) {
            console.warn('儲存棋譜失敗', e);
        }
    },

    exportRecord() {
        if (G.moveHistory.length === 0) {
            Toast.show('尚無棋譜可匯出');
            return;
        }
        const lines = ['# 六子棋棋譜', `# 版本: v${VERSION}`, `# 日期: ${new Date().toLocaleString()}`];
        if (G.mode === 'ai') lines.push(`# 模式: vs AI (${G.aiLevel}段)`);
        else lines.push('# 模式: 雙人對戰');
        lines.push(`# 場景: ${SceneManager.scenes[G.scene].name}`);
        lines.push('');
        G.moveHistory.forEach(m => {
            const color = m.turn === 1 ? '黑' : '白';
            lines.push(`${m.moveNum}. ${color} ${Board.toCoord(m.r, m.c)}`);
        });
        const text = lines.join('\n');
        const blob = new Blob([text], {type: 'text/plain'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `connect6_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(a.href);
        Toast.show('棋譜已匯出');
    },

    rebuildBoard() {
        Renderer.clearAll();
        Renderer.init();
        Renderer.redrawAll();
        if (G.gameOver) Renderer.drawWinLine();
    }
};

/* ============================================================
   9. UI 互動 (UI Interaction)
   ============================================================ */
const UI = {
    updateTurnIndicator() {
        const stone = document.getElementById('turnStone');
        const label = document.getElementById('turnLabel');
        stone.className = `turn-stone turn-stone--${G.currentTurn === 1 ? 'black' : 'white'}`;
        label.textContent = `${G.currentTurn === 1 ? '黑棋' : '白棋'}回合`;
    },

    updateStonesInfo() {
        document.getElementById('moveCount').textContent = G.moveHistory.length;
        document.getElementById('stonesToPlace').textContent = G.stonesToPlace;
    },

    updateStoneCount() {
        let black = 0, white = 0;
        G.moveHistory.forEach(m => m.turn === 1 ? black++ : white++);
        document.getElementById('blackCount').textContent = black;
        document.getElementById('whiteCount').textContent = white;
    },

    updateTimer() {
        const sec = Math.floor((Date.now() - G.startTime) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, '0');
        const s = String(sec % 60).padStart(2, '0');
        document.getElementById('gameTimer').textContent = `${m}:${s}`;
    },

    updateStatus(status) {
        document.getElementById('gameStatus').textContent = status;
    },

    addMoveToList(r, c, turn, moveNum) {
        const list = document.getElementById('moveList');
        const empty = list.querySelector('.empty-hint');
        if (empty) empty.remove();

        const item = document.createElement('div');
        item.className = 'move-item';
        item.innerHTML = `
            <span class="move-item__num">${moveNum}.</span>
            <span class="move-item__stone move-item__stone--${turn === 1 ? 'black' : 'white'}"></span>
            <span class="move-item__pos">${Board.toCoord(r, c)}</span>
        `;
        list.appendChild(item);
        list.scrollTop = list.scrollHeight;
    },

    rebuildMoveList() {
        const list = document.getElementById('moveList');
        list.innerHTML = '';
        if (G.moveHistory.length === 0) {
            list.innerHTML = '<p class="empty-hint">尚未開始對局</p>';
            return;
        }
        G.moveHistory.forEach(m => {
            UI.addMoveToList(m.r, m.c, m.turn, m.moveNum);
        });
    },

    clearMoveList() {
        const list = document.getElementById('moveList');
        list.innerHTML = '<p class="empty-hint">尚未開始對局</p>';
    },

    showAIThinking(show) {
        document.getElementById('aiThinking').classList.toggle('show', show);
    },

    showWinOverlay(title, desc) {
        const overlay = document.getElementById('winOverlay');
        document.getElementById('winTitle').textContent = title;
        document.getElementById('winDesc').textContent = desc;
        overlay.style.display = 'flex';
        Firework.start();
    },

    hideWinOverlay() {
        document.getElementById('winOverlay').style.display = 'none';
        Firework.stop();
    },

    setButtons(gameActive, gameOver = false) {
        document.getElementById('btnUndo').disabled = !gameActive || gameOver;
        document.getElementById('btnHint').disabled = !gameActive || gameOver;
        document.getElementById('btnResign').disabled = !gameActive || gameOver;
    }
};

/* ============================================================
   10-1. 簡易音效 (Sound)
   ============================================================ */
const Sound = {
    ctx: null,
    init() { if (!Sound.ctx) Sound.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
    play(type) {
        Sound.init();
        const ctx = Sound.ctx;
        switch (type) {
            case 'place': {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.frequency.value = 800;
                o.type = 'sine';
                g.gain.setValueAtTime(0.15, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
                o.connect(g); g.connect(ctx.destination);
                o.start(); o.stop(ctx.currentTime + 0.1);
                break;
            }
            case 'win':
                [
                    [523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]
                ].forEach(([f, d]) => {
                    const o2 = ctx.createOscillator();
                    const g2 = ctx.createGain();
                    o2.frequency.value = f; o2.type = 'triangle';
                    g2.gain.setValueAtTime(0.15, ctx.currentTime + d);
                    g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + d + 0.3);
                    o2.connect(g2); g2.connect(ctx.destination);
                    o2.start(ctx.currentTime + d);
                    o2.stop(ctx.currentTime + d + 0.3);
                });
                break;
        }
    }
};

/* ============================================================
   10-2. 煙火特效 (Firework)
   ============================================================ */
const Firework = {
    canvas: null,
    ctx: null,
    particles: [],
    rafId: null,

    start() {
        Firework.canvas = document.getElementById('fireworkCanvas');
        Firework.ctx = Firework.canvas.getContext('2d');
        const rect = Firework.canvas.parentElement.getBoundingClientRect();
        Firework.canvas.width = rect.width;
        Firework.canvas.height = rect.height;
        Firework.particles = [];
        Firework.spawn();
        Firework.loop();
    },

    spawn() {
        const w = Firework.canvas.width, h = Firework.canvas.height;
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                const cx = w * (0.2 + Math.random() * 0.6);
                const cy = h * (0.15 + Math.random() * 0.35);
                const hue = Math.random() * 360;
                for (let j = 0; j < 50; j++) {
                    const angle = (Math.PI * 2 * j) / 50;
                    const speed = 2 + Math.random() * 3;
                    Firework.particles.push({
                        x: cx, y: cy,
                        vx: Math.cos(angle) * speed,
                        vy: Math.sin(angle) * speed,
                        life: 1,
                        hue,
                        size: 2 + Math.random() * 2
                    });
                }
            }, i * 400);
        }
    },

    loop() {
        const ctx = Firework.ctx;
        if (!ctx) return;
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(0, 0, Firework.canvas.width, Firework.canvas.height);

        Firework.particles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            p.vy += 0.03; // gravity
            p.life -= 0.012;
            ctx.fillStyle = `hsla(${p.hue},100%,60%,${Math.max(p.life, 0)})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        });

        Firework.particles = Firework.particles.filter(p => p.life > 0);

        if (Firework.particles.length > 0) {
            Firework.rafId = requestAnimationFrame(Firework.loop);
        } else {
            setTimeout(() => {
                if (G.gameOver) { Firework.spawn(); Firework.loop(); }
            }, 800);
        }
    },

    stop() {
        if (Firework.rafId) cancelAnimationFrame(Firework.rafId);
        Firework.rafId = null;
        Firework.particles = [];
    }
};

/* ============================================================
   10-3. Toast 工具
   ============================================================ */
const Toast = {
    el: null,
    timer: null,
    show(msg, duration = 2000) {
        if (!Toast.el) Toast.el = document.getElementById('toast');
        Toast.el.textContent = msg;
        Toast.el.classList.add('show');
        if (Toast.timer) clearTimeout(Toast.timer);
        Toast.timer = setTimeout(() => {
            Toast.el.classList.remove('show');
        }, duration);
    }
};

/* ============================================================
   11. 載入完成初始化
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
    SceneManager.apply('inn');
    Renderer.init();
    AIClient.init();
    Douma.init();

    document.getElementById('btnStart').addEventListener('click', () => Game.start());
    document.getElementById('btnUndo').addEventListener('click', () => Game.undo());
    document.getElementById('btnHint').addEventListener('click', () => Game.hint());
    document.getElementById('btnResign').addEventListener('click', () => {
        if (confirm('確定要認輸嗎？')) Game.resign();
    });
    document.getElementById('btnNewGame').addEventListener('click', () => {
        UI.hideWinOverlay();
        Game.start();
    });
    document.getElementById('btnExport').addEventListener('click', () => Game.exportRecord());

    // 場景切換
    document.querySelectorAll('.scene-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            SceneManager.apply(btn.dataset.scene);
        });
    });

    // AI 設定面板顯示/隱藏
    document.querySelectorAll('input[name="mode"]').forEach(r => {
        r.addEventListener('change', () => {
            const aiSetting = document.getElementById('aiSetting');
            aiSetting.style.display = r.value === 'ai' && r.checked ? '' : 'none';
        });
    });

    // 座標、手數開關
    document.getElementById('toggleCoord').addEventListener('change', (e) => {
        G.showCoordinates = e.target.checked;
        if (G.gameStarted) Game.rebuildBoard();
    });
    document.getElementById('toggleNumber').addEventListener('change', (e) => {
        G.showMoveNumbers = e.target.checked;
        if (G.gameStarted) Renderer.redrawAll();
    });

    // 行動版分頁切換
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById('leftPanel').classList.toggle('show', tab === 'left');
            document.getElementById('rightPanel').classList.toggle('show', tab === 'right');
        });
    });

    // 預設顯示 AI 設定
    document.getElementById('aiSetting').style.display = '';

    console.log(`✅ 六子棋 Connect Six v${VERSION} 初始化完成`);
});
