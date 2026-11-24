// Diagnosis of the rotation: why a clock slot is skipped. Works on a copy of the station's
// settings, library and history, does not touch the channel on air. It shows the plan the
// channel holds for the next hours, then plans again from now and, for every slot that gets
// no song, says how many songs the category has and which rule leaves each one out.
//
//   "<install>\resources\runtime\node.exe" diagnostica-rotazione.mjs --ore 3
// Options: --code <program folder> --station <id> --ore 3
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
let code = arg('code');
if (!code) {
  try {
    code = path.join(home, 'code', JSON.parse(fs.readFileSync(path.join(home, 'code', 'current.json'), 'utf8')).dir);
  } catch {
    code = path.join(local, 'Programs', 'VisualRadioZ', 'resources', 'app');
  }
}
const station = path.join(home, 'stations', arg('station', 'winterland-locarno-tv'));
const hours = Number(arg('ore', 3));
const say = (m) => console.log(m);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vrz-rotazione-'));
fs.mkdirSync(path.join(work, 'data'));
for (const f of ['config.json', 'schedule.json']) if (fs.existsSync(path.join(station, f))) fs.copyFileSync(path.join(station, f), path.join(work, f));
for (const f of ['library.json', 'scheduler.json', 'playlist.json']) {
  if (fs.existsSync(path.join(station, 'data', f))) fs.copyFileSync(path.join(station, 'data', f), path.join(work, 'data', f));
}
const cfgRaw = JSON.parse(fs.readFileSync(path.join(work, 'config.json'), 'utf8'));
cfgRaw.dataDir = 'data';
fs.writeFileSync(path.join(work, 'config.json'), JSON.stringify(cfgRaw));
process.chdir(work);
process.env.WEBTV_HOME = work;
process.env.WEBTV_CONFIG = 'config.json';
process.env.WEBTV_SCHEDULE = 'schedule.json';

const imp = (f) => import(pathToFileURL(path.join(code, 'src', f)).href);
const { loadConfig } = await imp('config.ts');
const { Library } = await imp('library.ts');
const { loadSchedule } = await imp('schedule.ts');
const { Scheduler } = await imp('scheduler.ts');
const cfg = loadConfig('config.json');
const lib = new Library(cfg);
const book = loadSchedule(cfg);
const sched = new Scheduler(cfg, lib, book);
const p = sched.playlist;
const r = cfg.rotation;
say(`codice: ${code}`);
say(`regole: separazione titolo ${r.titleSeparationMinutes} min, artista ${r.artistSeparation} brani e ${r.artistSeparationMinutes} min, sequenze ${JSON.stringify(r.sequence ?? [])}, riserve ${JSON.stringify(r.backups ?? [])}`);
say(`libreria: ${lib.list().length} clip, ${lib.playable().length} riproducibili; storia: ${sched.history.length} passaggi`);
const hm = (t) => new Date(t).toTimeString().slice(0, 5);
const name = (c) => (c ? `${c.artist} - ${c.title}` : '?');
const catOf = (c) => {
  const cats = cfg.library.categories.filter((f) => p['pool'](f.name, new Map(), true).includes(c)).map((f) => f.name);
  return cats.join('/') || c.category;
};

// 1. The plan the channel holds now.
const now = Date.now();
const until = now + hours * 3600_000;
say(`\nPIANO ATTUALE DEL CANALE (prossime ${hours} ore):`);
for (const it of p.items.filter((it) => it.at <= until)) {
  const c = lib.get(it.id);
  say(`  ${hm(it.at)}  slot ${it.slot} [${it.index}] (${it.clock})  ${name(c)}  · categorie del brano: ${c ? catOf(c) : '?'}`);
}

// 2. A new plan from now, with the reason for every slot left without a song.
const reasons = [];
const orig = p['pickFor'].bind(p);
p['pickFor'] = (slot, st, at, pools, last = true) => {
  const c = orig(slot, st, at, pools, last);
  if (!c && !last) {
    const all = p['pool'](slot, pools, true);
    const out = p['excluded'](at);
    const kept = all.filter((x) => !out(x));
    const use = kept.length ? kept : all;
    const sepMs = r.artistSeparationMinutes * 60_000;
    const recent = new Set(r.artistSeparation > 0 ? st.recentArtists.slice(-r.artistSeparation).flat() : []);
    const artistOk = (x) => p['artistsOf'](x.artist).every((a) => !recent.has(a) && (sepMs <= 0 || at - (st.artistLast.get(a) ?? -Infinity) >= sepMs));
    const titleOk = (x) => at - (st.last.get(x.id) ?? -Infinity) >= r.titleSeparationMinutes * 60_000;
    const future = use.filter((x) => (st.last.get(x.id) ?? -Infinity) > at).length;
    reasons.push(`  ${hm(at)}  slot ${slot}: ${all.length} brani, ${kept.length} dopo l'esclusione dell'orologio; ` +
      `titolo riposato ${use.filter(titleOk).length}, artista riposato ${use.filter(artistOk).length}, entrambi ${use.filter((x) => titleOk(x) && artistOk(x)).length}; ` +
      `con un passaggio segnato nel futuro ${future}`);
  }
  return c;
};
p.items = [];
p.extend([], now, hours * 3600_000);
say(`\nPIANO RIFATTO DA ADESSO (${p.items.length} elementi):`);
for (const it of p.items) {
  const c = lib.get(it.id);
  say(`  ${hm(it.at)}  slot ${it.slot} [${it.index}]  ${name(c)}  · categorie del brano: ${c ? catOf(c) : '?'}`);
}
say(`\nSLOT SALTATI NEL PIANO RIFATTO (${reasons.length}):`);
for (const l of reasons) say(l);
say('\nFINE: copia tutto questo testo e mandalo.');
process.exit(0);
