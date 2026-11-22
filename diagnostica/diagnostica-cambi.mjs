// Diagnosis of the sound lost at clip changes, on the computer where it happens.
// It builds a few clip changes with the program's own code and the ffmpeg that the
// installed program carries, then measures where sound goes missing: in the pieces made
// for each clip (decoders) or in the encoder that joins them. It does not touch the
// channel on air: it works in a temporary folder and encodes with the processor (libx264),
// not with the graphics chip the channel uses. About two minutes.
//
//   "<install>\resources\runtime\node.exe" diagnostica-cambi.mjs
// Options: --code <program folder>  --ffmpeg <ffmpeg.exe>  --station <station id>  --clips 4
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const home = path.join(appData, 'VisualRadioZ');
const resources = path.join(local, 'Programs', 'VisualRadioZ', 'resources');
const exe = process.platform === 'win32' ? '.exe' : '';

// The code in use: the update named in code\current.json, else the installed one.
let code = arg('code');
if (!code) {
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(home, 'code', 'current.json'), 'utf8'));
    code = path.join(home, 'code', cur.dir);
  } catch {
    code = path.join(resources, 'app');
  }
}
const ffmpeg = arg('ffmpeg', path.join(resources, 'runtime', `ffmpeg${exe}`));
const ffprobe = arg('ffprobe', path.join(path.dirname(ffmpeg), `ffprobe${exe}`));
const stationId = arg('station', 'winterland-locarno-tv');
const nClips = Number(arg('clips', 4));
const station = path.join(home, 'stations', stationId);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrz-diagnostica-'));
const say = (m) => console.log(m);
say(`codice: ${code}`);
say(`ffmpeg: ${ffmpeg}`);
say(spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout.split('\n')[0]);
say(`cartella di prova: ${work}`);

// The station's own settings, without outputs, in the temporary folder.
const cfgRaw = JSON.parse(fs.readFileSync(path.join(station, 'config.json'), 'utf8'));
cfgRaw.dataDir = 'data';
cfgRaw.output = { ...cfgRaw.output, targets: [], preview: false };
fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify(cfgRaw));
process.env.WEBTV_HOME = work;
process.env.FFMPEG = ffmpeg;
process.env.FFPROBE = ffprobe;
const imp = (f) => import(pathToFileURL(path.join(code, 'src', f)).href);
const { loadConfig } = await imp('config.ts');
const { decoderArgs } = await imp('segment.ts');
const { encoderArgs } = await imp('encoder.ts');
const cfg = loadConfig('config.json');
cfg.overlay.stinger.enabled = false;
const fps = cfg.output.fps;

// Real clips of the station's library, the first ones that can play.
const lib = JSON.parse(fs.readFileSync(path.join(station, 'data', 'library.json'), 'utf8'))
  .filter((c) => c.type === 'music' && c.probed && !c.error && c.hasAudio && c.cueOut - c.cueIn > 60 && fs.existsSync(c.file))
  .slice(0, nClips);
if (lib.length < 2) throw new Error('servono almeno due brani della libreria raggiungibili da questo computer');
say(`brani: ${lib.map((c) => `${c.artist} - ${c.title}`).join(' | ')}`);

// Segments as the engine makes them: 20 s of each clip, a 2 s crossfade into the next one.
const L = 20;
const D = 2;
const plans = [];
let ts = 0;
lib.forEach((clip, i) => {
  const next = lib[i + 1];
  plans.push({
    id: i + 1, clip, start: clip.cueIn + (i ? D : 0), length: L, fadeIn: 0, fadeOut: 0, titleAt: null, tsOffset: ts,
    ...(next ? { next: { clip: next, start: next.cueIn, duration: D, video: D, tailFade: 0 } } : {}),
  });
  ts += L;
});

const run = (cmd, args, input) => new Promise((ok, fail) => {
  const p = spawn(cmd, args, { windowsHide: true });
  const out = [];
  let err = '';
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', fail);
  p.on('close', (code) => ok({ code, out: Buffer.concat(out), err }));
  if (input) fs.createReadStream(input).pipe(p.stdin);
});

/** Packets of a TS file per stream: how many, and the time they span. */
function span(file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time,duration_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const s = { video: { n: 0, first: Infinity, end: 0, gaps: [] }, audio: { n: 0, first: Infinity, end: 0, gaps: [] } };
  for (const line of r.stdout.split(/\r?\n/)) {
    const [type, pts, dur] = line.split(',');
    const t = s[type];
    if (!t || pts === 'N/A') continue;
    const p = Number(pts);
    const d = Number(dur) || 0;
    if (t.n && p - t.end > 0.1) t.gaps.push(`${t.end.toFixed(2)}→${p.toFixed(2)}`);
    t.n++;
    t.first = Math.min(t.first, p);
    t.end = Math.max(t.end, p + d);
  }
  return s;
}

const segFiles = [];
for (const plan of plans) {
  const r = await run(ffmpeg, decoderArgs(cfg, plan));
  const f = path.join(work, `pezzo${plan.id}.ts`);
  fs.writeFileSync(f, r.out);
  segFiles.push(f);
  const s = span(f);
  say(`pezzo ${plan.id}: video ${s.video.n} fotogrammi = ${(s.video.n / fps).toFixed(3)} s (da ${s.video.first.toFixed(3)}), ` +
    `audio ${(s.audio.end - s.audio.first).toFixed(3)} s (da ${s.audio.first.toFixed(3)}), previsto ${plan.length} s` +
    (r.code ? ` · ERRORE ffmpeg ${r.code}: ${r.err.trim().split('\n').pop()}` : ''));
}
const all = path.join(work, 'tutti.ts');
fs.writeFileSync(all, Buffer.concat(segFiles.map((f) => fs.readFileSync(f))));
const sAll = span(all);
say(`pezzi uniti: video ${(sAll.video.n / fps).toFixed(3)} s, audio ${(sAll.audio.end - sAll.audio.first).toFixed(3)} s, buchi audio: ${sAll.audio.gaps.join(' ') || 'nessuno'}`);

// The encoder, as on air but with the processor and without outputs: real time, so it takes a while.
say(`encoder in corso (circa ${plans.length * L} s)…`);
const args = encoderArgs(cfg, 'libx264', '', [], 0);
const enc = await run(ffmpeg, args, all);
const out = path.join(work, 'uscita.ts');
fs.writeFileSync(out, enc.out);
const sOut = span(out);
const vOut = sOut.video.end - sOut.video.first;
const aOut = sOut.audio.end - sOut.audio.first;
say(`uscita encoder: video ${vOut.toFixed(3)} s, audio ${aOut.toFixed(3)} s, differenza ${(aOut - vOut).toFixed(3)} s; buchi audio: ${sOut.audio.gaps.join(' ') || 'nessuno'}`);
const warnings = enc.err.split(/\r?\n/).filter((l) => l.trim() && !/^frame=|^\s*$|speed=/.test(l));
say(`messaggi dell'encoder (${warnings.length}):`);
for (const w of warnings.slice(0, 40)) say(`  ${w.trim()}`);
say('FINE: copia tutto questo testo e mandalo.');
