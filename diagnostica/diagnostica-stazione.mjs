// Diagnosis on air conditions: a full copy of a station (settings, schedule, logo, stinger,
// cards, library, playlist) runs with the program's own engine for a few minutes, writing
// to a file instead of the network, then the file is measured: picture and sound length,
// holes in the sound and where they fall against the clip changes.
// It does not touch the channel on air: its own folder, its own panel port, no outputs.
// By default it encodes with the processor (libx264), not with the graphics chip the channel
// uses; --encoder h264_qsv repeats the test with Quick Sync (it then shares the chip).
//
//   "<install>\resources\runtime\node.exe" diagnostica-stazione.mjs --minuti 12
// Options: --code <program folder> --ffmpeg <ffmpeg.exe> --station <id> --minuti 12 --encoder libx264 --anteprima --tagli --audio off
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
const home = path.join(appData, 'VisualRadioZ');
const resources = path.join(local, 'Programs', 'VisualRadioZ', 'resources');
const exe = process.platform === 'win32' ? '.exe' : '';
let code = arg('code');
if (!code) {
  try {
    code = path.join(home, 'code', JSON.parse(fs.readFileSync(path.join(home, 'code', 'current.json'), 'utf8')).dir);
  } catch {
    code = path.join(resources, 'app');
  }
}
const ffmpeg = arg('ffmpeg', path.join(resources, 'runtime', `ffmpeg${exe}`));
const ffprobe = arg('ffprobe', path.join(path.dirname(ffmpeg), `ffprobe${exe}`));
const node = arg('node', process.execPath);
const minutes = Number(arg('minuti', 12));
const encoder = arg('encoder', 'libx264');
const station = path.join(home, 'stations', arg('station', 'winterland-locarno-tv'));
const PORT = 18997;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrz-stazione-'));
const say = (m) => console.log(m);
say(`codice: ${code}`);
say(spawnSync(ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' }).stdout.split('\n')[0]);
say(`copia della stazione: ${work}`);

// The station as it is, without logs, preview and pictures made at start-up.
const skip = /[\\/]data[\\/](preview|tmp|asrun|events|cards|icons)([\\/]|$)|\.log$|closed-by-user$|launch\.lock$/;
fs.cpSync(station, work, { recursive: true, filter: (src) => !skip.test(src) });
const cfgFile = path.join(work, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const out = path.join(work, 'uscita.ts');
cfg.dataDir = 'data';
cfg.server = { ...cfg.server, port: PORT };
// --anteprima: also the local HLS preview, as on air (a second output).
cfg.output = { ...cfg.output, targets: [out], preview: process.argv.includes('--anteprima'), publicUrl: '', videoEncoder: encoder };
// --audio off|light|radio|loud: the encoder's sound processing (compressor, loudness, limiter).
const audioPreset = arg('audio');
if (audioPreset) {
  cfg.audio = { ...cfg.audio, processing: audioPreset };
  say(`processore audio dell'encoder: ${audioPreset}`);
}
// --burst N: ffmpeg's -readrate_initial_burst for the copy's encoder (2 by default).
const burst = arg('burst');
if (burst) {
  cfg.output.readrateBurst = Number(burst);
  say(`readrate_initial_burst: ${burst} s`);
}
// --tagli: clip changes as straight cuts instead of crossfades, to tell whether the crossfade is involved.
if (process.argv.includes('--tagli')) {
  cfg.types = { ...cfg.types, music: { ...cfg.types?.music, transition: 'cut', duration: 0 } };
  say('cambi brano: passaggi secchi (senza dissolvenza)');
}
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));

say(`la copia va in onda su file per ${minutes} minuti (encoder ${encoder})…`);
const log = [];
const st = spawn(node, [path.join(code, 'src', 'main.ts')], {
  cwd: work,
  env: { ...process.env, WEBTV_HOME: work, WEBTV_CONFIG: 'config.json', WEBTV_SCHEDULE: 'schedule.json', FFMPEG: ffmpeg, FFPROBE: ffprobe },
  windowsHide: true,
});
const start = Date.now();
st.stdout.on('data', (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
st.stderr.on('data', (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
await new Promise((r) => setTimeout(r, minutes * 60000));
await fetch(`http://127.0.0.1:${PORT}/api/quit`, { method: 'POST' }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));
st.kill();

// Picture and sound packets of the output.
const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time,duration_time', '-of', 'csv=p=0', out], { encoding: 'utf8', maxBuffer: 1 << 29 });
const s = { video: { n: 0, first: Infinity, end: 0 }, audio: { n: 0, first: Infinity, end: 0, gaps: [] } };
for (const line of r.stdout.split(/\r?\n/)) {
  const [type, pts, dur] = line.split(',');
  const t = s[type];
  if (!t || pts === 'N/A') continue;
  const p = Number(pts);
  const d = Number(dur) || 0;
  if (type === 'audio' && t.n && Math.abs(p - t.end) > 0.05) t.gaps.push({ at: t.end - s.audio.first, size: p - t.end });
  t.n++;
  t.first = Math.min(t.first, p);
  t.end = Math.max(t.end, p + d);
}
const v = s.video.end - s.video.first;
const a = s.audio.end - s.audio.first;
say(`uscita: video ${v.toFixed(2)} s, audio ${a.toFixed(2)} s, differenza audio-video ${(a - v).toFixed(2)} s`);
say(`salti nei tempi dell'audio (${s.audio.gaps.length}): ${s.audio.gaps.map((g) => `a ${g.at.toFixed(1)} s ${g.size > 0 ? 'buco' : 'sovrapposizione'} di ${Math.abs(g.size).toFixed(2)} s`).join(' · ') || 'nessuno'}`);
// Sound against picture every 5 minutes of output: shows when a gap starts to grow.
{
  const pk = r.stdout.split(/\r?\n/).map((l) => l.split(',')).filter((x) => x[1] && x[1] !== 'N/A');
  const v0 = s.video.first;
  const marks = [];
  let lastV = 0;
  let lastA = 0;
  for (const [type, pts] of pk) {
    if (type === 'video') lastV = Number(pts);
    else if (type === 'audio') lastA = Number(pts);
    const t = lastV - v0;
    if (lastA && t >= (marks.length + 1) * 300) marks.push(`${Math.round(t / 60)} min: ${((lastA - lastV) * 1000).toFixed(0)} ms`);
  }
  say(`audio meno video nell'uscita, ogni 5 minuti: ${marks.join(' · ') || 'prova troppo corta'}`);
}
say('registro della copia (cambi brano, correzioni, encoder):');
for (const l of log.filter((l) => /in onda|riallineato|stato:|encoder|errore|fermo|salt|scheda/i.test(l)).slice(0, 80)) say(`  ${l}`);
say(`durata reale della prova ${((Date.now() - start) / 1000).toFixed(0)} s`);
say('FINE: copia tutto questo testo e mandalo.');
