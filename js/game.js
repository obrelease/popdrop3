// ===================================================================
// 物理演算マッチ3（サバイバル版）
// Matter.js を使った、落下 → 近接判定 → 3個以上の同色消去 → 連鎖
//
// 今回の仕組み：
// ・いつでも盤面全体をチェックするのではなく、
//   「今関係があるボール」だけを監視リスト(watchList)に入れて
//   そのボールが止まったときだけ、そのボールを起点に判定する。
// ・消せなかったターンが累計3回になると、ボールが追加される（盤面が高いほど多い）。
// ・ボールがゲームオーバーライン（Line4）に届いたら GAME OVER。
//
// 判定方法について（重要）：
// 以前は Matter.js の「物理的な衝突イベント」(collisionStart/End)で
// 「どのボールが接触しているか」を記録していたが、これは不正確だった。
// 横に並んだボールは重力で押し合う力がないため、物理エンジンの計算上は
// ほんの少しだけ隙間が空いてしまい、見た目では繋がっているのに
// 「衝突していない」と判定されてしまうことがあった。
// そこで、同色判定は「ボールの中心と中心の距離」で行うようにしている
// （ADJACENCY_DISTANCE を参照）。見た目で繋がって見える距離なら
// 繋がっているとみなす、という考え方。
// ===================================================================

// ---- Matter.js のモジュールを取り出す ----
const { Engine, Render, Runner, World, Bodies, Events } = Matter;

// ---- ゲームフィールドの大きさ（内部座標） ----
const WIDTH = 400;
const HEIGHT = 650;
const WALL_THICKNESS = 20;
const BALL_RADIUS = 22;
// ゲーム開始時に、あらかじめ配置しておくボールの個数（30〜40個）
const INITIAL_BALL_MIN = 30;
const INITIAL_BALL_MAX = 40;

// ---- 盤面のボールの6色（初期配置・追加ボールはこの6色だけ。ずっと固定） ----
const BOARD_COLORS = [
  "#e74c3c", // 赤
  "#3498db", // 青
  "#f1c40f", // 黄
  "#2ecc71", // 緑
  "#9b59b6", // 紫
  "#e67e22", // オレンジ
];

// ---- プレイヤーが落とすボールだけに出てくる追加色（スコアに応じて順に解放） ----
// 盤面には存在しない色なので、同じ色を自分で3個集めないと消せない＝難しくなる
const PLAYER_EXTRA_COLORS = [
  "#ff6fb5", // ピンク
  "#00d2d3", // シアン
  "#ecf0f1", // 白
];
const PLAYER_COLORS = [...BOARD_COLORS, ...PLAYER_EXTRA_COLORS];

// ---- 色ごとのシンボル（色だけに頼らず、形でもボールを見分けられるようにする） ----
// 色覚の違いで見分けにくい組み合わせ（特に赤と緑）は、形がはっきり違うものにしている。
// シンボルの色は、ボールとのコントラスト比が 3.5 以上になるように
// 「ボールより濃い同系色」か「白」を選んでいる。
const BALL_SYMBOLS = {
  "#e74c3c": { shape: "heart", color: "#ffffff" }, // 赤 ♥
  "#3498db": { shape: "diamond", color: "#0d3554" }, // 青 ◆
  "#f1c40f": { shape: "star", color: "#6b4f00" }, // 黄 ★
  "#2ecc71": { shape: "plus", color: "#0b4d2a" }, // 緑 ✚
  "#9b59b6": { shape: "sparkle", color: "#ffffff" }, // 紫 ✦
  "#e67e22": { shape: "square", color: "#5a2800" }, // オレンジ ■
  "#ff6fb5": { shape: "circle", color: "#7d1446" }, // ピンク ●
  "#00d2d3": { shape: "triangle", color: "#004f50" }, // シアン ▲
  "#ecf0f1": { shape: "moon", color: "#566573" }, // 白 ☾
};

// シンボルの大きさ（中心から端までの長さ）。ボールの半径に対する割合
const SYMBOL_SIZE_RATIO = 0.42;

// 中心 (x, y)、大きさ size のシンボルを1つ描く
function drawSymbol(ctx, shape, x, y, size) {
  const s = size;
  ctx.beginPath();

  if (shape === "diamond") {
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s * 0.72, y);
    ctx.lineTo(x, y + s);
    ctx.lineTo(x - s * 0.72, y);
  } else if (shape === "star" || shape === "sparkle") {
    // star：5つの角 / sparkle：4つの角で、内側を深くへこませる
    const points = shape === "star" ? 5 : 4;
    const inner = shape === "star" ? s * 0.45 : s * 0.3;
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 === 0 ? s : inner;
      const angle = -Math.PI / 2 + (i * Math.PI) / points;
      ctx.lineTo(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
    }
  } else if (shape === "square") {
    const h = s * 0.75;
    ctx.rect(x - h, y - h, h * 2, h * 2);
  } else if (shape === "circle") {
    ctx.arc(x, y, s * 0.75, 0, Math.PI * 2);
  } else if (shape === "triangle") {
    ctx.moveTo(x, y - s);
    ctx.lineTo(x + s * 0.95, y + s * 0.7);
    ctx.lineTo(x - s * 0.95, y + s * 0.7);
  } else if (shape === "plus") {
    const w = s * 0.32; // 線の太さの半分
    ctx.rect(x - w, y - s, w * 2, s * 2);
    ctx.rect(x - s, y - w, s * 2, w * 2);
  } else if (shape === "heart") {
    ctx.moveTo(x, y + s * 0.85);
    ctx.bezierCurveTo(x - s * 1.3, y - s * 0.05, x - s * 0.6, y - s * 1.05, x, y - s * 0.4);
    ctx.bezierCurveTo(x + s * 0.6, y - s * 1.05, x + s * 1.3, y - s * 0.05, x, y + s * 0.85);
  } else if (shape === "moon") {
    // 大きい円から、右上にずらした円をくり抜いた三日月。
    // くり抜く円が外にはみ出さないよう、大きい円の中だけに描く
    const r = s * 0.85;
    ctx.save();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.moveTo(x + s * 0.3 + s * 0.7, y - s * 0.3);
    ctx.arc(x + s * 0.3, y - s * 0.3, s * 0.7, 0, Math.PI * 2);
    ctx.fill("evenodd");
    ctx.restore();
    return;
  }

  ctx.closePath();
  ctx.fill();
}

// 盤面のすべてのボールの中央にシンボルを描く。
// ボールが転がっても、シンボルは常に正立させる（向きが変わると見分けにくいため）
function drawBallSymbols(ctx) {
  const size = BALL_RADIUS * SYMBOL_SIZE_RATIO;
  for (const ball of ballsById.values()) {
    if (ball.isClearing) continue; // 消去演出中のボールは演出側でシンボルごと描く
    const symbol = BALL_SYMBOLS[ball.color];
    if (!symbol) continue;
    ctx.fillStyle = symbol.color;
    drawSymbol(ctx, symbol.shape, ball.position.x, ball.position.y, size);
  }
}

// ---- プレイヤーが落とせる色数は、スコアに応じて増える ----
// 0点〜:6色 / 1000点〜:7色 / 3000点〜:8色 / 6000点〜:9色
const PLAYER_COLOR_UNLOCKS = [
  { score: 6000, colors: 9 },
  { score: 3000, colors: 8 },
  { score: 1000, colors: 7 },
  { score: 0, colors: 6 },
];

function getUnlockedCountForScore(currentScore) {
  return PLAYER_COLOR_UNLOCKS.find((unlock) => currentScore >= unlock.score).colors;
}

let unlockedColorCount = getUnlockedCountForScore(0);

// ---- スコア ----
let score = 0;
const scoreEl = document.getElementById("score");
const nextBallEl = document.getElementById("next-ball");

// ---- 消せなかったターンの回数（累積） ----
// 消せなかったターンが累計 MISS_LIMIT 回になったら、ボールを追加するイベントが起きる。
// 消去に成功しても missCount は減らない。リセットされるのはボール追加イベントの後だけ。
const MISS_LIMIT = 3;
let missCount = 0;
const missDisplayEl = document.getElementById("miss-display");

function updateMissDisplay() {
  missDisplayEl.textContent = `${Math.min(missCount, MISS_LIMIT)}/${MISS_LIMIT}`;
}
updateMissDisplay();

// ---- 画面中央に出す告知バナー（NEW COLOR! / +5 BALLS!） ----
const bannerEl = document.getElementById("banner");
let bannerTimeoutId = null;

function showBanner(text, duration = 1000) {
  bannerEl.textContent = text;
  bannerEl.classList.add("show");
  if (bannerTimeoutId) clearTimeout(bannerTimeoutId);
  bannerTimeoutId = setTimeout(() => {
    bannerEl.classList.remove("show");
  }, duration);
}

// ---- Matter.js のエンジンを作成 ----
const engine = Engine.create();
const world = engine.world;
world.gravity.y = 1; // 通常の重力

// ---- 描画（Render）の設定 ----
const canvas = document.getElementById("game-canvas");
const render = Render.create({
  canvas: canvas,
  engine: engine,
  options: {
    width: WIDTH,
    height: HEIGHT,
    wireframes: false,
    background: "#0f1115",
  },
});
Render.run(render);

// ---- 物理エンジンを進める（Runner） ----
const runner = Runner.create();
Runner.run(runner, engine);

// ---- フィールドの壁（長方形：左壁・右壁・床のみ。金魚鉢型にしない） ----
const wallOptions = { isStatic: true, render: { fillStyle: "#555b6e" } };

const leftWall = Bodies.rectangle(
  WALL_THICKNESS / 2,
  HEIGHT / 2,
  WALL_THICKNESS,
  HEIGHT,
  wallOptions
);
const rightWall = Bodies.rectangle(
  WIDTH - WALL_THICKNESS / 2,
  HEIGHT / 2,
  WALL_THICKNESS,
  HEIGHT,
  wallOptions
);
const floor = Bodies.rectangle(
  WIDTH / 2,
  HEIGHT - WALL_THICKNESS / 2,
  WIDTH,
  WALL_THICKNESS,
  wallOptions
);

World.add(world, [leftWall, rightWall, floor]);

// ===================================================================
// 危険ライン（y座標。小さいほど上）
// Line1〜3 は内部判定専用（画面には出さない）。盤面が高いほど追加ボールが増える。
// Line4 はゲームオーバーライン。ボールの上端がここに届いたら即 GAME OVER。
// 初期配置（最大5段）の上端は y≈418 なので、開始直後はどのラインにも届かない。
// 1段 ≒ 42px なので、ライン同士の間隔はおよそ2段分。
// ===================================================================
const LINE1_Y = 380;
const LINE2_Y = 290;
const LINE3_Y = 200;
const GAME_OVER_LINE_Y = 110; // Line4

// 盤面で一番高い「着地済み」ボールの上端の y を返す（ボールがなければ床の位置）
// 落下中のボールは、上から落ちてくる途中で必ずラインを横切るので数えない。
function getHighestLandedBallTop() {
  let top = HEIGHT - WALL_THICKNESS;
  for (const ball of ballsById.values()) {
    if (!ball.landed || ball.isClearing) continue; // これから消えるボールは数えない
    top = Math.min(top, ball.position.y - BALL_RADIUS);
  }
  return top;
}

// MISSが3回に達したときの追加ボール数を、盤面の高さから決める
function getBonusBallCount() {
  const top = getHighestLandedBallTop();
  if (top <= LINE3_Y) return 15;
  if (top <= LINE2_Y) return 10;
  if (top <= LINE1_Y) return 7;
  return 5;
}

// ---- ゲームオーバー ----
let isGameOver = false;
const gameOverEl = document.getElementById("game-over");

function checkGameOver() {
  if (isGameOver) return;
  if (getHighestLandedBallTop() > GAME_OVER_LINE_Y) return;

  isGameOver = true;
  Runner.stop(runner); // 盤面をその瞬間の状態で止める
  document.getElementById("final-score").textContent = score;
  gameOverEl.classList.add("show");
  Sound.gameOver();
}

document.getElementById("retry-button").addEventListener("click", () => {
  location.reload();
});

// ---- ゲームオーバーライン（Line4）の描画 ----
// ラインより上を薄い赤で塗り、ライン自体は太めの赤線で描く
Events.on(render, "afterRender", () => {
  const ctx = render.context;
  drawBallSymbols(ctx);
  drawClearEffects(ctx);

  const left = WALL_THICKNESS;
  const right = WIDTH - WALL_THICKNESS;

  ctx.save();
  const zone = ctx.createLinearGradient(0, 0, 0, GAME_OVER_LINE_Y);
  zone.addColorStop(0, "rgba(231, 76, 60, 0)");
  zone.addColorStop(1, "rgba(231, 76, 60, 0.18)");
  ctx.fillStyle = zone;
  ctx.fillRect(left, 0, right - left, GAME_OVER_LINE_Y);

  ctx.strokeStyle = "#ff3b3b";
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(255, 59, 59, 0.8)";
  ctx.shadowBlur = 8;
  ctx.setLineDash([12, 6]);
  ctx.beginPath();
  ctx.moveTo(left, GAME_OVER_LINE_Y);
  ctx.lineTo(right, GAME_OVER_LINE_Y);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ff3b3b";
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("GAME OVER LINE", right - 4, GAME_OVER_LINE_Y - 6);
  ctx.restore();
});

// ===================================================================
// ボール同士の「近さ」を、物理衝突ではなく中心間距離で判定する
// ===================================================================
// 現在フィールドにあるボールを ID で引けるようにする
const ballsById = new Map();

// 中心間の距離が ADJACENCY_DISTANCE 以内なら「繋がっている」とみなす。
// 目標は物理的な正確さではなく「プレイヤーが繋がって見えるなら消える」こと。
// ボールの直径(BALL_RADIUS*2)に余裕(ADJACENCY_SLACK)を足して、
// 見た目の隙間が ADJACENCY_SLACK px までなら繋がり扱いにする。
//
// 調整の目安（直径44px、静止した盤面で実測した中心間距離）：
//   42〜44px … 接触しているボール同士（物理演算で少しめり込む）
//   50〜69px … ずれて乗っている／斜めに寄りかかっている。見た目は繋がって見える
//   70px〜   … 間に別のボールが1個挟まっている。繋がって見えない
// → 余裕は 17（判定距離 61px）。
//   以前は 22（66px）だったが、斜めに寄りかかって隙間が見える 63〜66px あたりまで
//   繋がってしまい「離れて見えるのに消える」と感じたため、約8%縮めた。
//   70px に近づけすぎると、間に別の色が挟まったボール同士まで繋がってしまう点にも注意。
const ADJACENCY_SLACK = 17;
const ADJACENCY_DISTANCE = BALL_RADIUS * 2 + ADJACENCY_SLACK;

// 指定したボールから ADJACENCY_DISTANCE 以内にある、他のボールを返す
// （消去演出中のボールは、もう盤面に無いものとして扱う）
function getNearbyBalls(ball) {
  const nearby = [];
  for (const other of ballsById.values()) {
    if (other.id === ball.id || other.isClearing) continue;
    const dx = other.position.x - ball.position.x;
    const dy = other.position.y - ball.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= ADJACENCY_DISTANCE) nearby.push(other);
  }
  return nearby;
}

// ===================================================================
// 監視リスト（watchList）
// 「このボールが止まったら判定する」という予約だけを持つ。
// 盤面全体を毎回見るのではなく、関係があるボールだけをここに入れる。
// ===================================================================
const watchList = []; // { id, meta: { isPlayerTurn, chain }, queuedAt }
// chain：このボールで消えたら何連鎖目になるか（効果音の音程に使う）

const SETTLE_SPEED_THRESHOLD = 0.08; // この速さ以下になったら「止まった」とみなす
const SETTLE_MIN_DELAY = 150; // 監視登録後、最低これだけは様子を見る(ms)
const SETTLE_MAX_WAIT = 4000; // 念のための最大待機時間(ms)

function queueWatch(id, meta) {
  if (watchList.some((item) => item.id === id)) return; // 既に監視中なら追加しない
  watchList.push({ id, meta, queuedAt: performance.now() });
}

Events.on(engine, "afterUpdate", () => {
  const now = performance.now();
  for (let i = watchList.length - 1; i >= 0; i--) {
    const item = watchList[i];
    const ball = ballsById.get(item.id);

    if (!ball) {
      // 別の経路（連鎖など）で既に消えていた
      watchList.splice(i, 1);
      continue;
    }

    const elapsed = now - item.queuedAt;
    if (elapsed < SETTLE_MIN_DELAY) continue;

    const speed = Math.hypot(ball.velocity.x, ball.velocity.y);
    if (speed < SETTLE_SPEED_THRESHOLD || elapsed > SETTLE_MAX_WAIT) {
      watchList.splice(i, 1);
      // 一度止まったボールは「着地済み」として、ライン判定の対象になる。
      // 判定で消えたボールは盤面から無くなるので、ラインの判定には残らない。
      ball.landed = true;
      evaluateBall(item.id, item.meta);
    }
  }

  checkGameOver();
});

// ===================================================================
// 着地音：ボールが何かにぶつかった瞬間、ぶつかった勢いに応じてクリック音を鳴らす
// ===================================================================
const LAND_SOUND_MIN_SPEED = 2; // これより弱い接触（積まれたボールの小さな揺れ）は鳴らさない
const LAND_SOUND_MAX_SPEED = 12; // これ以上は最大の強さとして扱う
const LAND_SOUND_BALL_COOLDOWN = 250; // ms。同じボールが跳ねるたびに鳴り続けないようにする

Events.on(engine, "collisionStart", (event) => {
  const now = performance.now();
  let strongest = 0;
  for (const pair of event.pairs) {
    const { bodyA, bodyB, collision } = pair;
    const balls = [bodyA, bodyB].filter((body) => body.isBall);
    if (balls.length === 0) continue;
    if (balls.every((ball) => now - (ball.lastLandSoundAt || 0) < LAND_SOUND_BALL_COOLDOWN)) continue;

    // ぶつかった方向（法線）に沿った、2つの物体の近づく速さ
    const relativeX = bodyA.velocity.x - bodyB.velocity.x;
    const relativeY = bodyA.velocity.y - bodyB.velocity.y;
    const speed = Math.abs(relativeX * collision.normal.x + relativeY * collision.normal.y);
    if (speed < LAND_SOUND_MIN_SPEED) continue;

    for (const ball of balls) ball.lastLandSoundAt = now;
    strongest = Math.max(strongest, speed);
  }
  if (strongest === 0) return;

  const impact = Math.min(
    1,
    (strongest - LAND_SOUND_MIN_SPEED) / (LAND_SOUND_MAX_SPEED - LAND_SOUND_MIN_SPEED)
  );
  Sound.land(impact);
});

// ===================================================================
// 同色グループの探索・消去（「盤面全体」ではなく指定した1個が起点）
// ===================================================================
function collectSameColorGroup(rootId) {
  const rootBall = ballsById.get(rootId);
  if (!rootBall) return [];

  const color = rootBall.color;
  const visited = new Set([rootId]);
  const queue = [rootBall];
  const group = [rootId];

  while (queue.length > 0) {
    const current = queue.shift();

    for (const neighbor of getNearbyBalls(current)) {
      if (visited.has(neighbor.id)) continue;
      if (neighbor.color === color) {
        visited.add(neighbor.id);
        queue.push(neighbor);
        group.push(neighbor.id);
      }
    }
  }

  return group;
}

// グループを消去し、「消えたボールの近くにいた、まだ残っているボール」のIDを返す
// → これが連鎖で次に判定すべき「周辺」になる（色は問わない。周辺が動くかもしれないので）
function removeGroup(group) {
  const groupSet = new Set(group);
  const freedNeighbors = new Set();

  for (const id of group) {
    const ball = ballsById.get(id);
    if (!ball) continue;
    for (const neighbor of getNearbyBalls(ball)) {
      if (!groupSet.has(neighbor.id)) freedNeighbors.add(neighbor.id);
    }
  }

  for (const id of group) {
    const ball = ballsById.get(id);
    if (ball) {
      World.remove(world, ball);
      ballsById.delete(id);
    }
  }

  return freedNeighbors;
}

// ===================================================================
// 消去演出：泡やグミが「ぽん」とはじけるように
// ・ボールが 100% → 115% → 125% とふくらみ、そこで弾けて 0% に縮む（合計 0.18 秒）
// ・弾けた瞬間に、同じ色の小さな粒が外側にふわっと広がり、透明になって消える
// 弾ける瞬間（CLEAR_POP_AT）までは物理的なボールを残しておき、
// その瞬間に盤面から取り除く。周りのボールはそこから落ち始める。
// ===================================================================
const CLEAR_DURATION = 180; // ms。ふくらみ始めてから見えなくなるまで
const CLEAR_POP_AT = 120; // ms。弾けて盤面から取り除くタイミング
// ふくらみ方：[時刻(ms), 大きさ]。この点の間をなめらかにつなぐ
const CLEAR_SCALE_KEYS = [
  [0, 1],
  [60, 1.15],
  [CLEAR_POP_AT, 1.25],
  [CLEAR_DURATION, 0],
];

// 粒子の数：1個のボールにつき PARTICLE_MIN〜PARTICLE_MAX 個。
// 連鎖を派手にしたくなったら PARTICLE_EXTRA_PER_CHAIN を増やす（2連鎖目から1段ごとに追加）
const PARTICLE_MIN = 4;
const PARTICLE_MAX = 8;
const PARTICLE_EXTRA_PER_CHAIN = 0;
const PARTICLE_LIFETIME = 420; // ms
const PARTICLE_SPEED_MIN = 50; // px/秒
const PARTICLE_SPEED_MAX = 110;
const PARTICLE_DRAG = 4; // 大きいほど早く止まる（ふわっと広がって止まる感じ）
const PARTICLE_RISE = 30; // px/秒²。泡のようにほんの少し浮き上がる

const clearingBalls = []; // { ball, x, y, color, startedAt }
const particles = []; // { x, y, vx, vy, radius, color, bornAt }

function getParticleCount(chain) {
  const base = PARTICLE_MIN + Math.floor(Math.random() * (PARTICLE_MAX - PARTICLE_MIN + 1));
  return base + Math.max(0, chain - 1) * PARTICLE_EXTRA_PER_CHAIN;
}

// group のボールの消去演出を始め、弾ける瞬間に onPop を呼ぶ
function startClearEffect(group, chain, onPop) {
  const now = performance.now();
  for (const id of group) {
    const ball = ballsById.get(id);
    if (!ball) continue;
    ball.isClearing = true;
    ball.render.visible = false; // 本体は演出側で、大きさを変えて描く
    clearingBalls.push({ ball, x: ball.position.x, y: ball.position.y, color: ball.color, startedAt: now });
  }

  setTimeout(() => {
    for (const id of group) {
      const ball = ballsById.get(id);
      if (ball) emitParticles(ball.position.x, ball.position.y, ball.color, chain);
    }
    onPop();
  }, CLEAR_POP_AT);
}

function emitParticles(x, y, color, chain) {
  const count = getParticleCount(chain);
  const now = performance.now();
  const angleOffset = Math.random() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    // ぐるっと均等に散らしつつ、少しだけ角度と速さをばらつかせる
    const angle = angleOffset + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const speed = PARTICLE_SPEED_MIN + Math.random() * (PARTICLE_SPEED_MAX - PARTICLE_SPEED_MIN);
    const startDistance = BALL_RADIUS * 0.8;
    particles.push({
      x: x + Math.cos(angle) * startDistance,
      y: y + Math.sin(angle) * startDistance,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: 2.5 + Math.random() * 2.5,
      color,
      bornAt: now,
    });
  }
}

// キーの間をなめらかにつないだ、時刻 t(ms) での大きさ
function getClearScale(t) {
  for (let i = 1; i < CLEAR_SCALE_KEYS.length; i++) {
    const [t1, s1] = CLEAR_SCALE_KEYS[i];
    const [t0, s0] = CLEAR_SCALE_KEYS[i - 1];
    if (t <= t1) {
      const p = (t - t0) / (t1 - t0);
      const eased = p * p * (3 - 2 * p); // smoothstep
      return s0 + (s1 - s0) * eased;
    }
  }
  return 0;
}

let lastEffectsTime = performance.now();

function drawClearEffects(ctx) {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastEffectsTime) / 1000);
  lastEffectsTime = now;

  // ふくらんで弾けるボール本体（とシンボル）
  for (let i = clearingBalls.length - 1; i >= 0; i--) {
    const item = clearingBalls[i];
    const t = now - item.startedAt;
    if (t >= CLEAR_DURATION) {
      clearingBalls.splice(i, 1);
      continue;
    }
    // 弾けるまではボールの動きについていき、その後は最後の位置に残す
    if (ballsById.has(item.ball.id)) {
      item.x = item.ball.position.x;
      item.y = item.ball.position.y;
    }
    const scale = getClearScale(t);
    if (scale <= 0.01) continue;

    ctx.beginPath();
    ctx.fillStyle = item.color;
    ctx.arc(item.x, item.y, BALL_RADIUS * scale, 0, Math.PI * 2);
    ctx.fill();

    const symbol = BALL_SYMBOLS[item.color];
    if (symbol) {
      ctx.fillStyle = symbol.color;
      drawSymbol(ctx, symbol.shape, item.x, item.y, BALL_RADIUS * SYMBOL_SIZE_RATIO * scale);
    }
  }

  // 粒子
  const dragFactor = Math.exp(-PARTICLE_DRAG * dt);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const life = (now - p.bornAt) / PARTICLE_LIFETIME;
    if (life >= 1) {
      particles.splice(i, 1);
      continue;
    }
    p.vx *= dragFactor;
    p.vy = p.vy * dragFactor - PARTICLE_RISE * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    const fade = 1 - life;
    ctx.globalAlpha = fade * fade; // 最初ははっきり、最後はすっと消える
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(p.x, p.y, p.radius * (0.6 + 0.4 * fade), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// 3個消去:30点 / 4個:40点 / 5個:50点 … 1個増えるごとに+10点
function calcScore(groupSize) {
  return 30 + (groupSize - 3) * 10;
}

// デバッグ表示：判定の様子をコンソールに出す。不要になったら false にすればよい。
const DEBUG_LOG = true;

// meta.isPlayerTurn が true のときだけ、missCount（消せなかった回数）が増える。
// 連鎖や追加ボールの判定では isPlayerTurn を false にして呼ぶ。
function evaluateBall(id, meta) {
  if (!ballsById.has(id)) return;
  if (ballsById.get(id).isClearing) return; // すでに別のグループとして消える途中

  const targetBall = ballsById.get(id);
  const group = collectSameColorGroup(id);

  if (DEBUG_LOG) {
    // 判定距離の調整用：対象ボールの近くにある同色ボールまでの距離（判定距離外も含む）
    const nearbySameColor = [];
    for (const other of ballsById.values()) {
      if (other.id === id || other.color !== targetBall.color) continue;
      const distance = Math.hypot(
        other.position.x - targetBall.position.x,
        other.position.y - targetBall.position.y
      );
      if (distance <= ADJACENCY_DISTANCE + 20) nearbySameColor.push(Math.round(distance));
    }
    nearbySameColor.sort((a, b) => a - b);

    console.log(
      `[判定] 対象ボールID=${id} 色=${targetBall.color} ` +
        `グループサイズ=${group.length} ` +
        `隣接判定距離=${ADJACENCY_DISTANCE}px(直径${BALL_RADIUS * 2}+余裕${ADJACENCY_SLACK}) ` +
        `近くの同色ボールまでの距離=[${nearbySameColor.join(", ")}] ` +
        `(isPlayerTurn=${meta.isPlayerTurn})`
    );
  }

  if (group.length >= 3) {
    score += calcScore(group.length);
    updateScore();

    // 一瞬ふくらんでから弾ける演出のあと、盤面から取り除く
    startClearEffect(group, meta.chain, () => {
      const freedNeighbors = removeGroup(group);
      Sound.clear(meta.chain, group.length);

      // 連鎖：消去によって周りにいたボールが動く可能性があるので、
      // そのボールたちが落ち着いたらまた判定する（盤面全体ではなく周辺だけ）
      // そこで消えたら「次の段の連鎖」になる
      for (const neighborId of freedNeighbors) {
        queueWatch(neighborId, { isPlayerTurn: false, chain: meta.chain + 1 });
      }
    });
  } else if (meta.isPlayerTurn) {
    missCount += 1;
    updateMissDisplay();

    if (missCount >= MISS_LIMIT && !bonusBallsInProgress) {
      triggerBonusBalls();
    }
  }
}

function updateScore() {
  scoreEl.textContent = score;

  const newUnlockedCount = getUnlockedCountForScore(score);
  if (newUnlockedCount > unlockedColorCount) {
    unlockedColorCount = newUnlockedCount;
    showBanner("NEW COLOR!");
  }
}

// ===================================================================
// ボール追加イベント：消せなかったターンが累計 MISS_LIMIT 回になったら、ボールを追加する
// 追加数は発生した瞬間の盤面の高さで決まる（通常5 / Line1:7 / Line2:10 / Line3:15）
// （ペナルティ＝罰ではなく、「新しいボールが登場する」というイベントとして扱う）
// ===================================================================
let bonusBallsInProgress = false;
const BONUS_BALL_DROP_INTERVAL = 300; // ms。少しずつ時間差で落とす

function triggerBonusBalls() {
  bonusBallsInProgress = true;
  const bonusCount = getBonusBallCount();
  showBanner(`+${bonusCount} BALLS!`);
  Sound.bonus(bonusCount);

  const minX = WALL_THICKNESS + BALL_RADIUS;
  const maxX = WIDTH - WALL_THICKNESS - BALL_RADIUS;
  const slotWidth = (maxX - minX) / bonusCount;

  for (let i = 0; i < bonusCount; i++) {
    setTimeout(() => {
      if (isGameOver) return;

      // フィールド内を追加数と同じ数の区画に分け、それぞれの区画の中のランダムな位置から落とす
      const slotStart = minX + slotWidth * i;
      const x = slotStart + Math.random() * slotWidth;
      // 追加ボールは盤面の色（6色固定）から選ぶ
      const color = BOARD_COLORS[Math.floor(Math.random() * BOARD_COLORS.length)];

      const ball = spawnBall(x, BALL_RADIUS + 2, color);
      // 追加ボールの消去は、プレイヤーの成功ターンとして数えない
      queueWatch(ball.id, { isPlayerTurn: false, chain: 1 });

      if (i === bonusCount - 1) {
        // 追加中（MISS 3/3 表示中）に重ねて失敗した分は、次のカウントに持ち越す
        missCount = Math.max(0, missCount - MISS_LIMIT);
        updateMissDisplay();
        bonusBallsInProgress = false;
        if (missCount >= MISS_LIMIT) {
          triggerBonusBalls();
        }
      }
    }, i * BONUS_BALL_DROP_INTERVAL);
  }
}

// ===================================================================
// 次に落とすボールの色（画面に表示する）
// ===================================================================
function pickRandomColor() {
  const pool = PLAYER_COLORS.slice(0, unlockedColorCount);
  return pool[Math.floor(Math.random() * pool.length)];
}

let nextColor = pickRandomColor();

// 「次のボール」にもシンボルを出す（高解像度画面でもにじまないよう、画素数を合わせる）
const nextBallCanvas = document.getElementById("next-ball-symbol");
const NEXT_BALL_CANVAS_SIZE = 24;
const nextBallPixelRatio = window.devicePixelRatio || 1;
nextBallCanvas.width = NEXT_BALL_CANVAS_SIZE * nextBallPixelRatio;
nextBallCanvas.height = NEXT_BALL_CANVAS_SIZE * nextBallPixelRatio;

function updateNextBallDisplay() {
  nextBallEl.style.backgroundColor = nextColor;

  const ctx = nextBallCanvas.getContext("2d");
  ctx.setTransform(nextBallPixelRatio, 0, 0, nextBallPixelRatio, 0, 0);
  ctx.clearRect(0, 0, NEXT_BALL_CANVAS_SIZE, NEXT_BALL_CANVAS_SIZE);
  const symbol = BALL_SYMBOLS[nextColor];
  ctx.fillStyle = symbol.color;
  const half = NEXT_BALL_CANVAS_SIZE / 2;
  // HUD のボールは盤面より小さいので、シンボルも同じ比率で縮める
  drawSymbol(ctx, symbol.shape, half, half, half * SYMBOL_SIZE_RATIO);
}
updateNextBallDisplay();

// ===================================================================
// ボールを1個作ってフィールドに追加する（共通処理）
// ===================================================================
function spawnBall(x, y, color) {
  const ball = Bodies.circle(x, y, BALL_RADIUS, {
    restitution: 0.3,
    friction: 0.4,
    render: {
      fillStyle: color,
    },
  });

  ball.isBall = true;
  ball.color = color;

  World.add(world, ball);
  ballsById.set(ball.id, ball);
  return ball;
}

// ===================================================================
// ボールを落とす（プレイヤーの操作）
// ===================================================================
function dropBall(x) {
  if (isGameOver) return;

  const minX = WALL_THICKNESS + BALL_RADIUS;
  const maxX = WIDTH - WALL_THICKNESS - BALL_RADIUS;
  const clampedX = Math.max(minX, Math.min(maxX, x));

  const ball = spawnBall(clampedX, BALL_RADIUS + 2, nextColor);
  // このボールが止まったら、これを起点に判定する（プレイヤーのターンとして扱う）
  queueWatch(ball.id, { isPlayerTurn: true, chain: 1 });

  // 次のボールの色を新しく決める（解放されている色から抽選）
  nextColor = pickRandomColor();
  updateNextBallDisplay();
}

// ===================================================================
// 初期配置：30〜40個のボールを、落下演出なしで
// 「最初から積まれた状態」として配置する。
// 生成した時点で同色3個以上が繋がっている場所が存在しないように色を選ぶ。
// （この初期配置のボールは watchList に入れないので、判定は一切行われない）
// ===================================================================

// フィールドの内側にボールを格子状に並べたときの列数・間隔。
// OVERLAP は「隣同士が物理的にちゃんと接触している」と判定されるように、
// 見た目にはわからない程度（2px）だけ少し詰めて配置するための値。
const OVERLAP = 2;
const CELL = BALL_RADIUS * 2 - OVERLAP;
const innerWidth = WIDTH - WALL_THICKNESS * 2;
const GRID_COLS = Math.floor(innerWidth / CELL);

function buildInitialGrid(count, colors) {
  const rows = Math.ceil(count / GRID_COLS);

  // 各行に何個のボールを置くかを決める（下の行から詰めていく）
  const rowCounts = [];
  let remaining = count;
  for (let r = 0; r < rows; r++) {
    const n = Math.min(GRID_COLS, remaining);
    rowCounts.push(n);
    remaining -= n;
  }

  // ---- 同色3個以上が繋がらないように色を決める（Union-Find） ----
  const parent = new Map();
  const groupSize = new Map();
  const cellColor = new Map(); // "row,col" -> 色

  function find(key) {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(key, root);
    return root;
  }

  function union(keyA, keyB) {
    const rootA = find(keyA);
    const rootB = find(keyB);
    if (rootA === rootB) return;
    parent.set(rootA, rootB);
    groupSize.set(rootB, groupSize.get(rootB) + groupSize.get(rootA));
  }

  // 同じ色を選んだ場合に、左隣・下隣と繋がって何個のグループになるかを調べる
  function sizeIfColor(color, leftKey, bottomKey) {
    let size = 1;
    const countedRoots = new Set();
    for (const neighborKey of [leftKey, bottomKey]) {
      if (neighborKey && cellColor.get(neighborKey) === color) {
        const root = find(neighborKey);
        if (!countedRoots.has(root)) {
          countedRoots.add(root);
          size += groupSize.get(root);
        }
      }
    }
    return size;
  }

  const grid = []; // grid[r][c] = "row,col" キー or undefined

  for (let r = 0; r < rows; r++) {
    grid.push([]);
    const n = rowCounts[r];
    for (let c = 0; c < n; c++) {
      const key = `${r},${c}`;
      grid[r].push(key);

      const leftKey = c > 0 ? grid[r][c - 1] : null;
      const bottomKey = r > 0 && grid[r - 1][c] !== undefined ? grid[r - 1][c] : null;

      // 用意された色をランダムな順番で試し、3個以上繋がらない色を選ぶ
      const shuffledColors = [...colors].sort(() => Math.random() - 0.5);
      let chosenColor = shuffledColors[0];
      for (const candidate of shuffledColors) {
        if (sizeIfColor(candidate, leftKey, bottomKey) < 3) {
          chosenColor = candidate;
          break;
        }
      }

      cellColor.set(key, chosenColor);
      parent.set(key, key);
      groupSize.set(key, 1);

      if (leftKey && cellColor.get(leftKey) === chosenColor) union(key, leftKey);
      if (bottomKey && cellColor.get(bottomKey) === chosenColor) union(key, bottomKey);
    }
    for (let c = n; c < GRID_COLS; c++) {
      grid[r].push(undefined);
    }
  }

  return { rows, rowCounts, cellColor };
}

function setupInitialBoard(count) {
  const { rows, rowCounts, cellColor } = buildInitialGrid(count, BOARD_COLORS);

  for (let r = 0; r < rows; r++) {
    const n = rowCounts[r];
    // この行のボールをフィールド中央に揃えて配置する
    const rowExtent = (n - 1) * CELL + BALL_RADIUS * 2;
    const offsetX = (innerWidth - rowExtent) / 2;

    // r=0 が一番下の行。床のすぐ上から積み上げていく
    const y = HEIGHT - WALL_THICKNESS - BALL_RADIUS - r * CELL;

    for (let c = 0; c < n; c++) {
      const x = WALL_THICKNESS + offsetX + BALL_RADIUS + c * CELL;
      const color = cellColor.get(`${r},${c}`);
      const ball = spawnBall(x, y, color);
      ball.landed = true; // 最初から積まれているので着地済み扱い
      // 注意：ここでは queueWatch を呼ばない
      // → 初期配置のボールは監視対象に入らないので、判定が実行されない
    }
  }
}

setupInitialBoard(
  INITIAL_BALL_MIN +
    Math.floor(Math.random() * (INITIAL_BALL_MAX - INITIAL_BALL_MIN + 1))
);

// ===================================================================
// 入力：フィールドをタップ／クリックしたらその位置にボールを落とす
// ===================================================================
canvas.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  // マウスならここで音が有効になり、最初の1球目から鳴る。
  // タッチ（iPhone など）は指を離した時点で sound.js 側が有効にする
  Sound.unlock();

  const rect = canvas.getBoundingClientRect();
  // 画面上の座標をゲーム内部座標（WIDTH x HEIGHT）に変換する
  const scaleX = WIDTH / rect.width;
  const x = (event.clientX - rect.left) * scaleX;

  dropBall(x);
});
