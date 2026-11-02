// ===================================================================
// 効果音（Web Audio API による仮実装）
//
// 2段構成になっている：
// ・ゲームイベント層（Sound.land / Sound.clear / Sound.bonus / Sound.gameOver）
//   「いつ・どの音を・どの高さと大きさで鳴らすか」を決める。連鎖の「ポポポン」もここ。
// ・音色（ボイス）層（playVoice）
//   音そのもの。SOUND_FILES に音声ファイルが登録されていればそれを再生し、
//   無ければ下の SYNTH_VOICES で合成する。
//
// 音声ファイルへの差し替え方：
//   SOUND_FILES に { ボイス名: "ファイルのパス" } を書くだけ。
//   ピッチはファイルの再生速度(playbackRate)、音量はゲインで反映されるので、
//   連鎖で音程が上がる・着地の強さで音量が変わる、などの演出はそのまま残る。
//   ※ file:// で開いているとブラウザが音声ファイルの読み込みを止めることがある。
//     ファイルを使うときはローカルサーバー経由で開くこと。
// ===================================================================

const SOUND_FILES = {
  // land: "sounds/land.mp3",       // 着地のクリック音（1回分）
  // pop: "sounds/pop.mp3",         // 消去のポップ音（1回分。連鎖では高さを変えて複数回鳴らす）
  // bonus: "sounds/bonus.mp3",     // +BALLS の「ぽふっ」（まるごと1本）
  // gameover: "sounds/gameover.mp3", // GAME OVER の終了音（まるごと1本）
};

const MASTER_VOLUME = 0.7;

// 着地音の質感："pofu"（マシュマロ・クッション）/ "poyo"（柔らかいゴムボール）/ "purun"（グミ・ゼリー）
// sound-test.html で聞き比べて、気に入ったものをここに書く
const LAND_SOUND_STYLE = "purun";

// 設定画面の SOUND ON/OFF を保存する localStorage のキー（値は "on" / "off"。未保存なら ON）
const SOUND_SETTING_KEY = "popdrop3.sound";

const Sound = (() => {
  let ctx = null;
  let master = null;
  let direct = null;
  let noiseBuffer = null;
  const fileBuffers = {};
  let enabled = loadEnabled();

  // プライベートモードなどで localStorage が使えなくても、ゲームは止めず ON 扱いにする
  function loadEnabled() {
    try {
      return localStorage.getItem(SOUND_SETTING_KEY) !== "off";
    } catch (error) {
      return true;
    }
  }

  // OFF にすると、すべての効果音は playVoice() の入口で止まる。
  // 鳴っている途中の音（GAME OVER の和音など）も、出口の音量を 0 にしてすぐ消す
  function setEnabled(on) {
    enabled = on;
    try {
      localStorage.setItem(SOUND_SETTING_KEY, on ? "on" : "off");
    } catch (error) {
      // 保存できなくても、今回の起動中は切り替えた状態で動く
    }
    applyOutputVolume();
  }

  function isEnabled() {
    return enabled;
  }

  function applyOutputVolume() {
    if (!ctx) return;
    const volume = enabled ? MASTER_VOLUME : 0;
    master.gain.setValueAtTime(volume, ctx.currentTime);
    direct.gain.setValueAtTime(volume, ctx.currentTime);
  }

  // ブラウザは「ユーザー操作の後」でないと音を出させてくれないので、
  // タップ／クリックのたびに呼ぶ（下の UNLOCK_EVENTS で自動登録している）。
  // 鳴る状態になった後は state を見るだけなので、何度呼んでも軽い
  function unlock() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      // iPhone：何もしないと「環境音」扱いで、消音スイッチ ON のとき鳴らない（Safari 17+ で有効）
      if (navigator.audioSession) {
        try {
          navigator.audioSession.type = "playback";
        } catch (error) {
          // 対応していなくてもゲームは止めない
        }
      }

      ctx = new AudioContextClass({ latencyHint: "interactive" }); // 操作への反応を優先

      // たくさん同時に鳴っても音割れしないよう、最後にコンプレッサーを通す
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(compressor);
      compressor.connect(ctx.destination);

      // 着地音専用の出口。コンプレッサーは先読みのぶん数ms遅れるので、
      // 接触と同時に聞こえてほしい着地音だけはここから直接出す（小さい音なので音割れの心配はない）
      direct = ctx.createGain();
      direct.gain.value = MASTER_VOLUME;
      direct.connect(ctx.destination);

      noiseBuffer = createNoiseBuffer();
      loadSoundFiles();
      applyOutputVolume();
    }
    // "suspended" だけでなく、iPhone で着信やバックグラウンド後になる "interrupted" からも戻す
    if (ctx.state !== "running") {
      Promise.resolve(ctx.resume()).catch((error) => {
        console.warn("[sound] AudioContext を再開できませんでした", error);
      });
      playSilence();
    }
  }

  // 古い iPhone は、ユーザー操作の中で実際に何か鳴らさないと音の出口が開かないので、
  // 1サンプルだけの無音を鳴らしておく
  function playSilence() {
    const source = ctx.createBufferSource();
    source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    source.connect(ctx.destination);
    source.start(0);
  }

  // 音を有効にできる操作の一覧。タッチの pointerdown / touchstart はこれに当たらず、
  // iPhone ではそこで unlock() しても音が出ないため、指を離した時点のイベントで呼ぶ
  const UNLOCK_EVENTS = ["pointerup", "touchend", "click", "keydown"];
  for (const type of UNLOCK_EVENTS) {
    document.addEventListener(type, unlock, { capture: true, passive: true });
  }
  // 別アプリから戻ってきたときにも再開を試す（だめでも次のタップで戻る）
  document.addEventListener("visibilitychange", () => {
    if (ctx && document.visibilityState === "visible" && ctx.state !== "running") {
      Promise.resolve(ctx.resume()).catch(() => {});
    }
  });

  function isReady() {
    return ctx !== null && ctx.state === "running";
  }

  function createNoiseBuffer() {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  function loadSoundFiles() {
    for (const [name, url] of Object.entries(SOUND_FILES)) {
      fetch(url)
        .then((response) => response.arrayBuffer())
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          fileBuffers[name] = buffer;
        })
        .catch((error) => {
          // 読み込めなくても合成音で鳴るので、ゲームは止めない
          console.warn(`[sound] ${url} を読み込めなかったので合成音を使います`, error);
        });
    }
  }

  // ---- ボイス層：1つの音を鳴らす ----
  // options: { when: 何秒後に鳴らすか, pitch: 高さの倍率(1=基準), volume: 0〜1,
  //            impact: 0〜1（着地の強さ）, style: 着地音の質感（どちらも合成音用。ファイル再生では無視） }
  function playVoice(name, options = {}) {
    if (!enabled || !isReady()) return;
    const when = ctx.currentTime + (options.when || 0);
    const pitch = options.pitch || 1;
    const volume = options.volume === undefined ? 1 : options.volume;

    const buffer = fileBuffers[name];
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = pitch;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(master);
      source.start(when);
      return;
    }

    SYNTH_VOICES[name](when, pitch, volume, options);
  }

  // ---- 合成音の部品 ----
  // 音量の山（すぐ立ち上がって、指数的に消える）を付けたゲインノードを作る
  function envelope(when, peak, attack, decay) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    gain.connect(master);
    return gain;
  }

  function tone(type, frequency, when, peak, attack, decay, destination) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, when);
    const gain = envelope(when, peak, attack, decay);
    if (destination) {
      gain.disconnect();
      gain.connect(destination);
    }
    osc.connect(gain);
    osc.start(when);
    osc.stop(when + attack + decay + 0.05);
    return osc;
  }

  // ---- 着地音の部品 ----
  // 共通の考え方：
  // ・硬い物（板・石・木）っぽさの正体は「高い成分」と「すぐ消える鋭い響き」。
  //   なので全部を低めの lowpass に通し、響きを作るフィルター（bandpass の高い Q）は使わない
  // ・接触と同時に聞こえるよう、立ち上がりは数msの直線。出口はコンプレッサーを通らない direct
  // ・純粋な正弦波1本だと電子音っぽいので、わずかに高さをずらした2本＋こもった息を重ねる

  // 着地音の出口：全体を丸くする lowpass
  function landOutput(cutoff) {
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.5;
    filter.connect(direct);
    return filter;
  }

  // 0 から直線ですぐ立ち上がり、指数的に消える音量の山
  function landEnvelope(destination, when, peak, attack, decay) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    gain.connect(destination);
    return gain;
  }

  // こもった息（クッションやマシュマロがつぶれる「ふ」）
  function landPuff(destination, when, cutoff, peak, attack, decay) {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.playbackRate.value = 0.9 + Math.random() * 0.2; // 毎回ほんの少し違う質感に
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.3;
    noise.connect(filter);
    filter.connect(landEnvelope(destination, when, peak, attack, decay));
    noise.start(when);
    noise.stop(when + attack + decay + 0.02);
  }

  // 丸い芯の音。shapeFrequency(osc.frequency, 高さ倍率) で高さの動きを付ける。
  // ほんの少し高さをずらした2本を重ねて、電子音っぽい「まっすぐな音」を和らげる
  function landBody(destination, when, peak, attack, decay, shapeFrequency) {
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.detune.value = detune;
      shapeFrequency(osc.frequency);
      osc.connect(landEnvelope(destination, when, peak / 2, attack, decay));
      osc.start(when);
      osc.stop(when + attack + decay + 0.02);
    }
  }

  const LAND_STYLES = {
    // 「ポフ」：マシュマロやクッション。こもった息が主役で、下にうっすら低い芯
    pofu(when, pitch, volume, impact) {
      const length = 0.08 + impact * 0.08;
      const out = landOutput(900);
      landPuff(out, when, 420 * pitch, 1.1 * volume, 0.005, length);
      landBody(out, when, 0.28 * volume, 0.005, length * 0.9, (frequency) => {
        frequency.setValueAtTime(190 * pitch, when);
        frequency.exponentialRampToValueAtTime(120 * pitch, when + length);
      });
    },

    // 「ポヨ」：柔らかいゴムボール。一瞬つぶれて（少し上がって）から戻る（下がる）高さの動き
    poyo(when, pitch, volume, impact) {
      const length = 0.1 + impact * 0.08;
      const base = 220 * pitch;
      const out = landOutput(1000);
      landBody(out, when, 0.3 * volume, 0.006, length, (frequency) => {
        frequency.setValueAtTime(base * 0.85, when);
        frequency.linearRampToValueAtTime(base * 1.2, when + 0.025);
        frequency.exponentialRampToValueAtTime(base * 0.75, when + length);
      });
      landPuff(out, when, 500 * pitch, 0.35 * volume, 0.004, length * 0.5);
    },

    // 「プルン」：グミやゼリー。高さがぷるぷる揺れて、揺れがすぐ収まる
    purun(when, pitch, volume, impact) {
      const length = 0.13 + impact * 0.1;
      const base = 250 * pitch;
      const out = landOutput(1000);

      const jiggle = ctx.createOscillator();
      jiggle.frequency.value = 13;
      const jiggleDepth = ctx.createGain();
      jiggleDepth.gain.setValueAtTime(base * 0.09, when);
      jiggleDepth.gain.exponentialRampToValueAtTime(base * 0.005, when + length);
      jiggle.connect(jiggleDepth);
      jiggle.start(when);
      jiggle.stop(when + length + 0.03);

      landBody(out, when, 0.26 * volume, 0.006, length, (frequency) => {
        frequency.setValueAtTime(base * 1.08, when);
        frequency.exponentialRampToValueAtTime(base * 0.88, when + length);
        jiggleDepth.connect(frequency);
      });
      landPuff(out, when, 450 * pitch, 0.3 * volume, 0.004, length * 0.4);
    },
  };

  const SYNTH_VOICES = {
    // 着地：質感の違う3種類から LAND_SOUND_STYLE で選ぶ（下の LAND_STYLES を参照）
    land(when, pitch, volume, options) {
      const style = LAND_STYLES[options.style || LAND_SOUND_STYLE] || LAND_STYLES.pofu;
      style(when, pitch, volume, options.impact || 0);
    },

    // 消去：泡がはじけるような「ポン」。高さが一瞬で上に滑る
    pop(when, pitch, volume) {
      const base = 520 * pitch;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(base * 0.7, when);
      osc.frequency.exponentialRampToValueAtTime(base * 1.25, when + 0.05);
      const gain = envelope(when, 0.5 * volume, 0.004, 0.16);
      osc.connect(gain);
      osc.start(when);
      osc.stop(when + 0.25);

      // 輪郭を少しだけはっきりさせる倍音
      tone("triangle", base * 2.5, when, 0.08 * volume, 0.002, 0.05);
    },

    // +BALLS：警告ではなく「ぽふっ」と自然に増えた感じ。
    // 低めの丸い音が少し下がりながら消える「ぽ」＋こもった息のような「ふっ」。
    // 高音は全体を lowpass で落として、立ち上がりも少しゆっくりにして柔らかくしている
    bonus(when, pitch, volume) {
      const soft = ctx.createBiquadFilter();
      soft.type = "lowpass";
      soft.frequency.value = 1000;
      soft.Q.value = 0.5;
      soft.connect(master);

      const body = ctx.createOscillator();
      body.type = "sine";
      body.frequency.setValueAtTime(300 * pitch, when);
      body.frequency.exponentialRampToValueAtTime(170 * pitch, when + 0.14);
      const bodyGain = envelope(when, 0.22 * volume, 0.012, 0.22);
      bodyGain.disconnect();
      bodyGain.connect(soft);
      body.connect(bodyGain);
      body.start(when);
      body.stop(when + 0.3);

      const puff = ctx.createBufferSource();
      puff.buffer = noiseBuffer;
      const puffFilter = ctx.createBiquadFilter();
      puffFilter.type = "lowpass";
      puffFilter.frequency.value = 700;
      const puffGain = envelope(when + 0.01, 0.1 * volume, 0.02, 0.12);
      puffGain.disconnect();
      puffGain.connect(soft);
      puff.connect(puffFilter);
      puffFilter.connect(puffGain);
      puff.start(when + 0.01);
      puff.stop(when + 0.2);
    },

    // GAME OVER：ゆっくり降りてきて、明るい和音で静かに終わる（「おつかれさま」）
    gameover(when, pitch, volume) {
      const soft = ctx.createBiquadFilter();
      soft.type = "lowpass";
      soft.frequency.value = 2200;
      soft.connect(master);

      const melody = [784, 659.3, 523.3]; // ソ・ミ・ド
      melody.forEach((frequency, i) => {
        tone("triangle", frequency * pitch, when + i * 0.28, 0.22 * volume, 0.02, 0.6, soft);
      });

      const chordAt = when + melody.length * 0.28 + 0.1;
      const chord = [261.6, 329.6, 392, 523.3]; // ド・ミ・ソ・ド
      chord.forEach((frequency, i) => {
        tone("sine", frequency * pitch, chordAt + i * 0.03, 0.14 * volume, 0.08, 2.2, soft);
      });
    },
  };

  // ---- ゲームイベント層 ----

  // 着地の音が一度に重なりすぎないよう、間隔を空ける
  const LAND_MIN_INTERVAL = 0.035; // 秒
  let lastLandTime = 0;

  // impact: 0〜1（落下の勢い）。強いほど少し大きく、低く、長くなる
  // style: 聞き比べ用。省略すると LAND_SOUND_STYLE を使う
  function land(impact, style) {
    if (!enabled || !isReady()) return;
    if (ctx.currentTime - lastLandTime < LAND_MIN_INTERVAL) return;
    lastLandTime = ctx.currentTime;

    const pitch = 1.2 - impact * 0.45 + (Math.random() - 0.5) * 0.08; // 毎回ほんの少し揺らす
    const volume = 0.12 + impact * 0.5; // 一番多い小さな接触ほど小さく、強くても控えめに
    playVoice("land", { pitch, volume, impact, style });
  }

  // 音程の階段（ペンタトニック。どの音を重ねても濁りにくい）
  const POP_SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
  const POP_NOTE_GAP = 0.07; // 秒
  const POP_MAX_NOTES = 5;

  // chain: 何連鎖目か（1=プレイヤーの1手目で消えた）／ size: 消えた個数
  // 1連鎖「ポン」、2連鎖「ポポン」、3連鎖「ポポポン」…と音数が増え、
  // 連鎖が進むたびに出だしの音も1段ずつ高くなる
  function clear(chain, size) {
    const noteCount = Math.min(chain, POP_MAX_NOTES);
    const startStep = chain - 1;
    const volume = Math.min(1, 0.7 + (size - 3) * 0.08);

    for (let i = 0; i < noteCount; i++) {
      const step = Math.min(startStep + i, POP_SCALE.length - 1);
      const isLast = i === noteCount - 1;
      playVoice("pop", {
        when: i * POP_NOTE_GAP,
        pitch: Math.pow(2, POP_SCALE[step] / 12),
        volume: isLast ? volume : volume * 0.7, // 最後の「ン」を少し強く
      });
    }
  }

  // count: 追加されるボールの数。驚かせないよう、数が多いときもほんの少し低く重くするだけ
  function bonus(count) {
    const pitch = count >= 15 ? 0.9 : count >= 10 ? 0.95 : 1;
    playVoice("bonus", { pitch });
  }

  function gameOver() {
    playVoice("gameover");
  }

  return { unlock, land, clear, bonus, gameOver, playVoice, setEnabled, isEnabled };
})();
