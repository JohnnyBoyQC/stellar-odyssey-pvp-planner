// ==UserScript==
// @name         Stellar Odyssey – PvP Meta
// @namespace    stellarodyssey-pvpmeta
// @version      1.2.0
// @description  Arena build planner for Stellar Odyssey: the meta split at your own total stat, the best free re-spec, which upgrades pay, and a record of your duels. Built from Astrolabe 3.22.8's simulator. Keeps the squadron battles, arena duels and roster you browse, and opens them in the web planner in one click (player and squadron picker). Reads the page only: no network requests, no game actions.
// @match        *://steam.stellarodyssey.app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @homepageURL  https://github.com/JohnnyBoyQC/stellar-odyssey-pvp-planner
// @downloadURL  https://raw.githubusercontent.com/JohnnyBoyQC/stellar-odyssey-pvp-planner/main/pvp-meta.user.js
// @updateURL    https://raw.githubusercontent.com/JohnnyBoyQC/stellar-odyssey-pvp-planner/main/pvp-meta.user.js
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
     PvP Meta for Stellar Odyssey

     The PvP part of Astrolabe on its own: your arena build, the meta split
     at your own total stat, the best free re-spec, which upgrades pay, and
     a record of the duels you fight or open. The simulator, the planner and
     the duel recorder are Astrolabe's own functions, copied unchanged by a
     build step; only this panel around them is new.

     It reads the game page and nothing else: no network request of any
     kind, no clicks, no game actions (the game's rules allow scripts for
     information and display only).
     ============================================================ */

  /* ---- storage: its own keys, so it never touches Astrolabe's ---- */
  var store = {
    get: function (k, d) {
      var raw;
      try { if (typeof GM_getValue === 'function') raw = GM_getValue('sopvp:' + k); } catch (e) {}
      if (raw === undefined) { try { raw = localStorage.getItem('sopvp:' + k); } catch (e) {} }
      if (raw === undefined || raw === null) return d;
      try { return JSON.parse(raw); } catch (e) { return d; }
    },
    set: function (k, v) {
      var s;
      try { s = JSON.stringify(v); } catch (e) { return; }
      try { if (typeof GM_setValue === 'function') { GM_setValue('sopvp:' + k, s); return; } } catch (e) {}
      try { localStorage.setItem('sopvp:' + k, s); } catch (e) {}
    }
  };

  var PVP_DEFAULTS = {
    recBattles: true,   // record arena duels as they are fought or opened
    keepBadges: 0,      // PvP badges the upgrade plan must leave untouched
    bestGap: 2,         // floor on the gain worth a change; the real bar is twice the error bar
    archive: true       // keep squadron battles, arena duels, roster and map as they are browsed
  };

  var S = {
    inputs: Object.assign({}, PVP_DEFAULTS, store.get('inputs', {})),
    battles: store.get('battles', []),
    storeOk: false, storeState: null,
    lastErr: null, lastErrAt: 0, wkFail: null, wkLast: null
  };
  if (!Array.isArray(S.battles)) S.battles = [];

  function setErr(msg) { S.lastErr = msg || null; S.lastErrAt = msg ? Date.now() : 0; }
  function saveInputs() { store.set('inputs', S.inputs); }

  /* ---- the background worker: only the PvP jobs ---- */
  function WK_VARS() {
    return {
      AR_ASSUME: AR_ASSUME, AR_SPREAD: AR_SPREAD, CLONE_CRIT_BASE: CLONE_CRIT_BASE, PVP_HP_MULT: PVP_HP_MULT, PVP_SKILLS: PVP_SKILLS, PVP_STATS: PVP_STATS,
      PV_CONTESTED: PV_CONTESTED, PV_DECIDED: PV_DECIDED, PV_FLOOR: PV_FLOOR, PV_MAX_BATTLES: PV_MAX_BATTLES, PV_MIN_EACH: PV_MIN_EACH,
      PV_SEARCH_MAX: PV_SEARCH_MAX, PV_SEED: PV_SEED, PV_SIMS: PV_SIMS,
      PV_META: PV_META, PV_META_COPIES: PV_META_COPIES,
      RL_A: RL_A, RL_B: RL_B, RL_MAX_CLONES: RL_MAX_CLONES, RL_MAX_ROUNDS: RL_MAX_ROUNDS
    };
  }
  function WK_FNS() {
    return [numOr, btRng, arAssume, arDraws, arSide, pvAllocate, pvBestAssign, pvCompositions, pvCopy, pvGap, pvGearBase, pvGearVal, pvLevelCost,
      pvMetaPool, pvNeedFor, pvPlanRun, pvPool, pvPoolRef, pvReplay, pvSample, pvScore, pvScoreOf, pvSkills, pvSpend, pvTerm,
      pvTierCost, pvTotals, pvUpgradeRows, rlDuel, rlLeft, rlLoad, rlMe, rlPhase, rlSlot, rngStreams];
  }
  function wkMain() {
    self.onmessage = function (e) {
      var job = e.data;
      try {
        if (job.kind === 'pvp') {
          pvPlanRun(job.pv, job.recs, job.keep, function (plan, err) {
            self.postMessage({ type: 'plan', plan: plan || null, err: err ? String((err && err.message) || err) : null });
            self.postMessage({ type: 'done' });
          });
          return;
        } else if (job.kind === 'replay') {
          job.recs.forEach(function (rec, i) {
            var res;
            try { res = pvReplay(rec, job.sims); } catch (e) { res = { p: null, rounds: null }; }
            self.postMessage({ type: 'replay', i: i, res: res });
          });
        }
        self.postMessage({ type: 'done' });
      } catch (err) {
        self.postMessage({ type: 'error', err: String((err && err.message) || err) });
      }
    };
  }

  // Dark unless light was picked (1.2.0).
  var THEME = store.get('theme', 'dark');

  /* ============================================================
     PLAYER EXTRACT (1.2.0): shared by the userscript and the page

     Turns the battle archive (squadron battles with their full logs, arena
     duels) into one small card per player: damage, health, clones and the
     clones' crit and dual shot exactly as the game sent them, and
     precision, evasion and skills estimated from how the swings went.

     Squadron battles are a relay with a kill debuff: after k kills a
     member's damage, precision and evasion are x(1 - 0.2 x 1.25^(k-1)),
     at most -90% (measured on 19 live battles). Precision is read from the
     swings an enemy aimed at our own members, whose evasion is known
     exactly from the Squadron Groups roster, and evasion from our members'
     swings at it. Both sides' debuffs are taken into account swing by swing.
     ============================================================ */

  var PX_VER = 1;
  var PX_CHANCE = { dot: 0.05, focus: 0.025, stun: 0.05, block: 0.05 };
  var PX_SK = ['dot', 'focus', 'stun', 'block'];

  // Clones that are all alike are kept once.
  function pxClCompact(cl) {
    if (!cl || !cl.length) return [[0, 0, 0]];
    var a = String(cl[0]);
    for (var i = 1; i < cl.length; i++) if (String(cl[i]) !== a) return cl;
    return [cl[0]];
  }
  function pxNum(v) { var x = Number(v); return v !== null && v !== '' && isFinite(x) ? x : null; }
  function pxDebuff(k) { return k > 0 ? 1 - Math.min(0.9, 0.2 * Math.pow(1.25, k - 1)) : 1; }
  function pxOwner(name) { var m = /^(.*)'s Clone \d+$/.exec(String(name || '')); return m ? m[1] : null; }
  function pxHpLeft(s) { var m = /(-?\d+)\s*\/\s*(\d+)/.exec(String(s || '')); return m ? +m[1] : null; }

  // The members string of one side of a squadron battle.
  function pxMembers(s) {
    var a;
    try { a = typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return []; }
    if (!Array.isArray(a)) return [];
    return a.filter(function (m) { return m && m.user; }).map(function (m) {
      var cl = Array.isArray(m.clones) ? m.clones : [];
      return { user: String(m.user), d: pxNum(m.damage) || 0, h: pxNum(m.maxhp) || pxNum(m.hp) || 0, n: cl.length || 1,
        cl: pxClCompact(cl.map(function (c) { return [pxNum(c.critical_chance) || 0, pxNum(c.critical_damage) || 0, pxNum(c.dual_shot) || 0]; })) };
    });
  }

  // One member of the own roster (/api/squadrons/groups), with its totals
  // worked out as the game does (getPlayerPvPDamage / HP).
  function pxRosterMember(m, g, pos) {
    var ps = m.pvpstats || {}, lv = m.levels || {}, craft = pxNum(lv.crafting_level);
    if (craft === null && lv.crafting && typeof lv.crafting === 'object') craft = pxNum(lv.crafting.level);
    craft = craft || 0;
    var vp = m.velari_pet, vel = vp && vp.equipped ? (pxNum(vp.level) || 0) : 0;
    var gear = (Array.isArray(m.pvp_gear) ? m.pvp_gear : []).map(function (x) {
      return { name: String(x.name || 'piece'), stat: String(x.stat || '').toLowerCase(), skill: String(x.skill || '').toLowerCase(), L: pxNum(x.statLevel) || 0, T: pxNum(x.statTier) || 0, mat: String(x.statCost || '').toLowerCase() };
    });
    var cl = Array.isArray(m.clones) ? m.clones : [], N = cl.length || 1, tot = {}, pts = {};
    ['power', 'precision', 'evasion', 'hull'].forEach(function (s) {
      pts[s] = pxNum(ps[s]) || 0;
      var t = pts[s] + vel * 50;
      gear.forEach(function (x) { if (x.stat === s) t += 100 * x.L * (1 + x.T / 100 + craft / 100); });
      tot[s] = t;
    });
    var sk = { dot: 0, focus: 0, stun: 0, block: 0 };
    gear.forEach(function (x) { if (sk[x.skill] !== undefined) sk[x.skill]++; });
    return { user: String(m.username || ''), g: g, pos: pos, active: m.active !== false, pts: pts, avail: pxNum(ps.available) || 0, gear: gear, craft: craft, vel: vel,
      cl: pxClCompact(cl.map(function (c) { return [pxNum(c.critical_chance) || 0, pxNum(c.critical_damage) || 0, pxNum(c.dual_shot) || 0]; })),
      N: N, tot: tot, d: Math.floor(tot.power * N), h: Math.floor(tot.hull * 7 * N), sk: [sk.dot, sk.focus, sk.stun, sk.block] };
  }

  // A roster answer: {squad:[{group1:[...], group2, group3, available}]}.
  function pxRoster(body) {
    var sq = body && Array.isArray(body.squad) ? body.squad[0] : (body && body.group1 ? body : null), out = [];
    if (!sq) return out;
    [1, 2, 3].forEach(function (g) {
      (Array.isArray(sq['group' + g]) ? sq['group' + g] : []).forEach(function (m, i) { if (m && m.username) out.push(pxRosterMember(m, g, i + 1)); });
    });
    (Array.isArray(sq.available) ? sq.available : []).forEach(function (m) { if (m && m.username) out.push(pxRosterMember(m, 0, 0)); });
    return out;
  }

  // Reads one squadron battle, swing by swing.
  //   known(user) -> {p, e} for the members whose precision and evasion are
  //   known exactly (our own, from the roster), or null.
  function pxBattle(b, known) {
    var A = pxMembers(b.attacking_members), D = pxMembers(b.defending_members);
    var side = {}, mem = {}, alive = {}, kills = {}, order = { A: [], D: [] };
    A.forEach(function (m) { side[m.user] = 'A'; mem[m.user] = m; alive[m.user] = m.n; kills[m.user] = 0; });
    D.forEach(function (m) { side[m.user] = 'D'; mem[m.user] = m; alive[m.user] = m.n; kills[m.user] = 0; });
    var obs = {}, rounds = 0, win = null, lastAtt = null, deaths = [], first = null;
    function O(u) {
      return obs[u] || (obs[u] = { p: {}, e: {}, sk: { L: 0, dot: 0, focus: 0, stunT: 0, stun: 0, blkT: 0, blk: 0 }, sw: 0 });
    }
    function seen(u) { var s = side[u]; if (s && order[s].indexOf(u) < 0) order[s].push(u); }
    function add(map, R, succ) {
      var k = R.toPrecision(5), x = map[k] || (map[k] = [R, 0, 0]);
      x[1] += succ; x[2]++;
    }
    var logs = Array.isArray(b.logs) ? b.logs : [];
    for (var i = 0; i < logs.length; i++) {
      var e = logs[i], act = e && e.action;
      if (!act) continue;
      if (act === 'round') { rounds = pxNum(e.value) || pxNum(e.round) || rounds; continue; }
      if (act === 'won') {
        win = e.attacker && e.attacker !== '-' ? 'A' : (e.defender && e.defender !== '-' ? 'D' : null);
        var wn = e.attacker && e.attacker !== '-' ? e.attacker : e.defender;
        var an = b.attacking_squadron && b.attacking_squadron.name, dn = b.defending_squadron && b.defending_squadron.name;
        if (wn && wn === an) win = 'A'; else if (wn && wn === dn) win = 'D';
        continue;
      }
      var a = pxOwner(e.attacker), t = pxOwner(e.defender);
      if (a) seen(a);
      if (t) seen(t);
      if (act === 'dies') {
        if (t && alive[t] !== undefined && --alive[t] === 0) {
          var killer = lastAtt && side[lastAtt] !== side[t] ? lastAtt : null;
          if (killer) kills[killer]++;
          deaths.push([rounds, t, killer, killer ? kills[killer] : 0]);
        }
        continue;
      }
      if (!a || !side[a]) continue;
      lastAtt = a;
      // A DoT charge that kills ends the swing that burnt it: no attack line
      // follows, but the swing landed.
      var dotKill = act === 'DoT triggers' && (function () { var h = pxHpLeft(e.hpLeft); return h !== null && h <= 0; })();
      if (act === 'attacks' || act === 'misses hit on' || act === 'attack blocked' || dotKill) {
        if (first === null) first = a;
        if (!t || !side[t]) continue;
        var hit = act !== 'misses hit on' ? 1 : 0, fa = pxDebuff(kills[a]), ft = pxDebuff(kills[t]);
        var oa = O(a), ot = O(t), ka = known(a), kt = known(t);
        oa.sw++;
        // a's precision, from a swing at a target whose evasion is known
        if (kt && kt.e > 0) add(oa.p, kt.e * ft / fa, hit);
        // t's evasion, from a swing by an attacker whose precision is known
        if (ka && ka.p > 0) add(ot.e, ka.p * fa / ft, 1 - hit);
        if (hit) {
          oa.sk.L++; ot.sk.blkT++;
          if (act === 'attack blocked') ot.sk.blk++;
          else if (act === 'attacks') { var hl = pxHpLeft(e.hpLeft); if (hl === null || hl > 0) oa.sk.stunT++; }
        }
      } else if (act === 'applies DoT') O(a).sk.dot++;
      else if (act === 'stuns') O(a).sk.stun++;
      else if (act === 'focused') O(a).sk.focus++;
    }
    function grp(sq, g, ms) { return { sq: (sq && sq.name) || '?', sid: (sq && sq._id) || null, g: pxNum(g) || 0, m: ms }; }
    return {
      id: b._id, t: (pxNum(b.finished) || pxNum(b.created) || 0) * 1000,
      A: grp(b.attacking_squadron, b.attacking_group, A), D: grp(b.defending_squadron, b.defending_group, D),
      win: win, r: rounds, first: first, order: order, deaths: deaths, obs: obs
    };
  }

  // Most likely X when a swing succeeds with chance X / (X + R), from a list
  // of [R, successes, tries]; a weak prior of one success and one failure at
  // the typical R keeps an all-hit or all-miss record finite. se is on the
  // log scale (0.1 = about +-10%).
  function pxFit(obs) {
    var N = 0, S = 0, lr = 0;
    obs.forEach(function (o) { N += o[2]; S += o[1]; lr += o[2] * Math.log(o[0]); });
    if (N < 1) return null;
    var R0 = Math.exp(lr / N), all = obs.concat([[R0, 1, 2]]);
    var th = Math.log(R0) + Math.log((S + 1) / (N - S + 1)), h = 1;
    for (var it = 0; it < 50; it++) {
      var g = 0; h = 0;
      all.forEach(function (o) { var p = 1 / (1 + Math.exp(Math.log(o[0]) - th)); g += o[1] - o[2] * p; h += o[2] * p * (1 - p); });
      if (!(h > 0)) break;
      var step = Math.max(-2, Math.min(2, g / h));
      th += step;
      if (Math.abs(step) < 1e-7) break;
    }
    return { v: Math.exp(th), se: 1 / Math.sqrt(h), n: N, info: h };
  }

  function pxLogBin(x, n, p) {
    if (n <= 0) return 0;
    p = Math.min(0.999, Math.max(1e-4, p));
    return x * Math.log(p) + (n - x) * Math.log(1 - p);
  }
  // The four gear skills, as whole pieces: the most likely set of four (each
  // piece is 5%, Focus 2.5%), with how sure that is.
  function pxSkills(k) {
    var best = null, tot = 0, list = [];
    for (var a = 0; a <= 4; a++) for (var b = 0; a + b <= 4; b++) for (var c = 0; a + b + c <= 4; c++) {
      var d = 4 - a - b - c;
      var ll = pxLogBin(k.dot, k.L, a * PX_CHANCE.dot) + pxLogBin(k.focus, k.L, b * PX_CHANCE.focus) +
        pxLogBin(k.stun, k.stunT, c * PX_CHANCE.stun) + pxLogBin(k.blk, k.blkT, d * PX_CHANCE.block);
      list.push({ s: [a, b, c, d], ll: ll });
    }
    var mx = -Infinity;
    list.forEach(function (x) { if (x.ll > mx) mx = x.ll; });
    list.forEach(function (x) { x.w = Math.exp(x.ll - mx); tot += x.w; if (!best || x.ll > best.ll) best = x; });
    return { s: best.s, conf: Math.round(best.w / tot * 100) / 100, n: k.L + k.blkT };
  }

  function pxSumSk(a, b) { Object.keys(b).forEach(function (k) { a[k] = (a[k] || 0) + b[k]; }); return a; }

  // The whole archive to the extract.
  //   arc: { squad:[{battle}], duel:[{duel}], roster:[{t, body}] }
  //   me: our username; duels: duel records (arBuild's shape, with .nm)
  //   mePE: our own {p, e} now, for when no roster is on file
  function pxExtract(arc, me, duels, mePE) {
    var rosters = (arc.roster || []).map(function (r) {
      var body; try { body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch (e) { body = null; }
      return { t: r.t || 0, m: pxRoster(body) };
    }).filter(function (r) { return r.m.length; }).sort(function (x, y) { return x.t - y.t; });
    function rosterAt(t) {
      if (!rosters.length) return null;
      var pick = rosters[0];
      rosters.forEach(function (r) { if (r.t <= t) pick = r; });
      return pick;
    }
    var ownNames = {};
    rosters.forEach(function (r) { r.m.forEach(function (m) { ownNames[m.user] = 1; }); });

    // Which squadron is ours: the one in (nearly) every battle.
    var sqCount = {}, battles = (arc.squad || []).map(function (x) { return x && (x.battle || x); }).filter(function (b) { return b && Array.isArray(b.logs); });
    battles.forEach(function (b) {
      [b.attacking_squadron, b.defending_squadron].forEach(function (s) { if (s && s.name) sqCount[s.name] = (sqCount[s.name] || 0) + 1; });
    });
    var own = null;
    Object.keys(sqCount).forEach(function (k) { if (own === null || sqCount[k] > sqCount[own]) own = k; });

    var players = {}, groups = {}, summaries = [], snapsOf = {};
    function P(u) { return players[u] || (players[u] = { name: u, sq: null, t: 0, nb: 0, nd: 0, snaps: [] }); }
    battles.sort(function (x, y) { return (pxNum(x.finished) || 0) - (pxNum(y.finished) || 0); });
    battles.forEach(function (b) {
      var t = (pxNum(b.finished) || pxNum(b.created) || 0) * 1000, rs = rosterAt(t), idx = {};
      if (rs) rs.m.forEach(function (m) { idx[m.user] = m; });
      var res = pxBattle(b, function (u) {
        var m = idx[u];
        if (m) return { p: m.tot.precision, e: m.tot.evasion };
        if (u === me && mePE) return mePE;
        return null;
      });
      ['A', 'D'].forEach(function (s) {
        var G = res[s];
        var gk = G.sq + '|' + G.g, gr = groups[gk] || (groups[gk] = { sq: G.sq, g: G.g, own: G.sq === own ? 1 : 0, n: 0, t: 0, m: [], ord: [] });
        gr.n++;
        if (res.t >= gr.t) { gr.t = res.t; gr.m = G.m.map(function (m) { return m.user; }); gr.ord = res.order[s].slice(); }
        G.m.forEach(function (m) {
          var p = P(m.user);
          p.nb++;
          if (res.t >= p.t) { p.t = res.t; p.sq = G.sq; p.g = G.g; }
          var key = m.d + '|' + m.h + '|' + m.n, sn = null;
          p.snaps.forEach(function (x) { if (x.key === key) sn = x; });
          if (!sn) { sn = { key: key, d: m.d, h: m.h, n: m.n, cl: m.cl, t0: res.t, t1: res.t, nb: 0, p: [], e: [], sk: {} }; p.snaps.push(sn); }
          sn.nb++; sn.t0 = Math.min(sn.t0, res.t); sn.t1 = Math.max(sn.t1, res.t); sn.cl = m.cl;
          var o = res.obs[m.user];
          if (o) {
            Object.keys(o.p).forEach(function (k) { sn.p.push(o.p[k]); });
            Object.keys(o.e).forEach(function (k) { sn.e.push(o.e[k]); });
            pxSumSk(sn.sk, o.sk);
          }
        });
      });
      function sm(G) { return { sq: G.sq, g: G.g, m: G.m.map(function (m) { return [m.user, m.d, m.h, m.n, m.cl]; }) }; }
      summaries.push({ id: res.id, t: res.t, A: sm(res.A), D: sm(res.D),
        win: res.win, r: res.r, first: res.first, order: res.order, deaths: res.deaths });
    });

    // Arena duels: one fighter each, the opponent's numbers read off the log.
    (duels || []).forEach(function (r) {
      if (!r || !r.nm || !r.e || !r.o) return;
      var p = P(r.nm), f = r.e, q = f.q && f.q.length >= 4 ? f.q : null;
      p.nd++;
      if (r.t >= p.t) p.t = r.t;
      var key = 'duel|' + f.d + '|' + f.h + '|' + f.n, sn = null;
      p.snaps.forEach(function (x) { if (x.key === key) sn = x; });
      if (!sn) { sn = { key: key, duel: 1, d: f.d, h: f.h, n: f.n, cl: null, t0: r.t, t1: r.t, nb: 0, p: [], e: [], sk: {}, c: f.c }; p.snaps.push(sn); }
      sn.nb++; sn.t0 = Math.min(sn.t0, r.t); sn.t1 = Math.max(sn.t1, r.t);
      if (q && r.o.e > 0 && r.o.p > 0) {
        sn.p.push([r.o.e, q[0], q[1]]);
        sn.e.push([r.o.p, Math.max(0, q[3] - q[2]), q[3]]);
        var s = Array.isArray(f.s) ? f.s : [0, 0, 0, 0];
        pxSumSk(sn.sk, { L: q[0], dot: Math.round(s[0] * (q[1] + 4) / 100), focus: Math.round(s[1] * (q[1] + 4) / 100), stunT: q[0], stun: Math.round(s[2] * (q[1] + 4) / 100), blkT: q[2], blk: Math.round(s[3] * (q[2] + 4) / 100) });
      }
    });

    // One card per player: the latest build seen, and the estimates from
    // that build's battles when they are enough, else from all of them.
    var out = [];
    Object.keys(players).forEach(function (u) {
      var p = players[u];
      if (!p.snaps.length) return;
      p.snaps.sort(function (x, y) { return x.t1 - y.t1; });
      var sq = p.snaps.filter(function (x) { return !x.duel; }), last = (sq.length ? sq : p.snaps)[(sq.length ? sq : p.snaps).length - 1];
      function fitOf(which, list) { var all = []; list.forEach(function (x) { all = all.concat(x[which]); }); return pxFit(all); }
      var pL = fitOf('p', [last]), eL = fitOf('e', [last]), mixed = 0;
      var pA = fitOf('p', p.snaps), eA = fitOf('e', p.snaps);
      var pp = pL && pL.info >= 6 ? pL : pA, ee = eL && eL.info >= 6 ? eL : eA;
      if (pp !== pL || ee !== eL) mixed = p.snaps.length > 1 ? 1 : 0;
      var skk = {}; p.snaps.forEach(function (x) { pxSumSk(skk, x.sk); });
      var sk = skk.L || skk.blkT ? pxSkills({ L: skk.L || 0, dot: skk.dot || 0, focus: skk.focus || 0, stunT: skk.stunT || 0, stun: skk.stun || 0, blkT: skk.blkT || 0, blk: skk.blk || 0 }) : null;
      var cl = last.cl;
      if (!cl && last.c) cl = last.c.map(function (c) { return [c[0], c[1], c[2]]; });
      function r3(f) { return f ? [Math.round(f.v), Math.round(f.se * 1000) / 1000, f.n] : null; }
      out.push({ name: u, sq: p.sq, g: p.g || 0, own: ownNames[u] || p.sq === own ? 1 : 0, t: p.t, nb: p.nb, nd: p.nd, snaps: p.snaps.length, mixed: mixed,
        d: last.d, h: last.h, n: last.n, cl: cl || [[0, 0, 0]], P: r3(pp), E: r3(ee), sk: sk ? sk.s : null, skc: sk ? sk.conf : 0, skn: sk ? sk.n : 0 });
    });
    out.sort(function (x, y) { return y.t - x.t; });
    var rs = rosters.length ? rosters[rosters.length - 1] : null;
    return {
      v: PX_VER, made: Date.now(), me: me || null, own: own, players: out,
      groups: Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return y.t - x.t; }),
      roster: rs ? { t: rs.t, m: rs.m } : null, battles: summaries
    };
  }

  // A player card as a duel record the planner can fight (arSide / arDraws
  // shape). The hit counts are the Fisher-equivalent number of swings against
  // our own precision and evasion, so arDraws spreads the opponent by exactly
  // the doubt in the estimate. Unknown precision or evasion falls back on the
  // meta split (15% of the total next to 35% power) with very wide doubt.
  function pxRecord(card, myP, myE, k) {
    var N = card.n || 1, pow = card.d / N, hull = card.h / (7 * N);
    var guess = Math.max(20, (pow + hull) / 2 * 15 / 35);
    function q(f, ref, kind) {
      var v = f ? f[0] : guess, se = f ? Math.max(0.02, f[1]) : 0.6;
      var p = kind === 'p' ? v / (v + ref) : ref / (ref + v), n = Math.max(4, Math.round(1 / (se * se * p * (1 - p))));
      return [Math.round(p * n), n, v];
    }
    var qp = q(card.P, myE, 'p'), qe = q(card.E, myP, 'e');
    var sk = card.sk || [0, 0, 0, 4];
    return { v: 3, t: card.t || 0, i: 'vs|' + card.name + '|' + (k || 0), w: 0, f: 0, r: 0, nm: card.name,
      o: { p: myP, e: myE },
      e: { n: N, d: card.d, h: card.h, p: Math.round(qp[2]), e: Math.round(qe[2]),
        s: [sk[0] * 5, sk[1] * 2.5, sk[2] * 5, sk[3] * 5],
        c: (card.cl && card.cl.length ? card.cl : [[0, 0, 0]]).map(function (c) { return [c[0], c[1], c[2]]; }),
        // [their hits, their swings, our hits on them, our swings]
        q: [qp[0], qp[1], qe[0], qe[1]] } };
  }

  /* ============================================================
     OPEN IN PLANNER (1.2.0)

     One click sends your build, your recorded duels and a small card per
     player read from the battle archive to the planner web page, in the
     part of the link after '#'. Browsers never send that part to any
     server: it goes from this tab to the new one and nowhere else. Raw
     battle logs stay here; only the cards travel.
     ============================================================ */

  var PLANNER_URL = 'https://johnnyboyqc.github.io/stellar-odyssey-pvp-planner/';
  var PLANNER_ORIGIN = 'https://johnnyboyqc.github.io';
  var PL_MAX_URL = 1900000;   // Chrome takes links up to 2 MB; above that the data goes by message
  var PL = { busy: false, err: null, link: null, last: null };

  // From 1.2.0 a duel record also keeps the opponent's name, so the planner
  // can offer "plan against this player". Older records stay nameless.
  function recTick() {
    if (S.inputs.recBattles === false) return;
    var st = recState(), A = st && st.PvPArenaStore, d;
    try { d = A && A.currentDuel; } catch (e) { return; }
    if (!d || !d.logs || !d.logs.length) return;
    var fp = (d._id || '') + '|' + d.logs.length;
    if (fp === recSeen) return;
    var me = st.UserStore && st.UserStore.username;
    var rec = arBuild(d, me, readPvp(st), Date.now());
    if (!rec) {
      if (recTries.fp !== fp) recTries = { fp: fp, n: 0 };
      if (++recTries.n >= REC_TRIES) recSeen = fp;
      return;
    }
    rec.nm = String(d.attackerName === me ? d.defenderName : d.attackerName);
    recSeen = fp;
    var key = arKey(rec);
    if (S.battles.some(function (r) { return arKey(r) === key; })) return;
    S.battles.push(rec);
    S.battles.sort(function (x, y) { return x.t - y.t; });
    if (S.battles.length > AR_MAX) S.battles = S.battles.slice(-AR_MAX);
    store.set('battles', S.battles);
    if (panel.style.display !== 'none' && tab === 'battle') render();
  }

  // The build as the planner reads it: only the PvP part of the account.
  function plRoot(st) {
    var pv = st ? readPvp(st) : null;
    if (!pv) return null;
    var P = st.UserStore.player, vel = Math.round(pv.vel / 50);
    return {
      UserStore: { username: st.UserStore.username, pvp_badges: pv.badges, player: {
        pvp_gear: P.pvp_gear.map(function (g) { return { name: g.name, stat: g.stat, skill: g.skill, statLevel: g.statLevel, statTier: g.statTier, statCost: g.statCost }; }),
        pvpstats: { power: P.pvpstats.power, precision: P.pvpstats.precision, evasion: P.pvpstats.evasion, hull: P.pvpstats.hull, available: P.pvpstats.available },
        clones: (P.clones || []).map(function (c) { return { critical_chance: c.critical_chance, critical_damage: c.critical_damage, dual_shot: c.dual_shot }; }) } },
      CraftStore: { crafting_level: pv.craft },
      MaterialsStore: { materialsList: pv.gear.map(function (g) { return { item: { name: g.mat }, quantity: pv.mats[g.mat] || 0 }; }) },
      PetsStore: vel ? { petSlots: [{ pet: 'v' }], pets: [{ _id: 'v', name: 'Velari', level: vel }] } : { petSlots: [], pets: [] }
    };
  }

  function plPayload() {
    var st = recState() || S.storeState, me = st && st.UserStore && st.UserStore.username, pv = st ? readPvp(st) : null;
    var get = function (s) { return arcTx(s, 'readonly', function (os) { return os.getAll(); }).catch(function () { return []; }); };
    return Promise.all([get('squad'), get('duel'), get('roster')]).then(function (all) {
      var mine = function (x) { return x && x.realm === REALM; };
      var squad = all[0].filter(mine), duels = all[1].filter(mine), roster = all[2].filter(mine);
      // Duels: the recorded ones, plus every duel opened and kept whole in
      // the archive (those carry the opponent's name, so older ones get it too).
      var seen = {};
      S.battles.forEach(function (r) { seen[arKey(r)] = r; });
      duels.forEach(function (x) {
        var d = x.duel, r = d && me ? arBuild(d, me, pv, x.saved || Date.now()) : null;
        if (!r) return;
        r.nm = String(d.attackerName === me ? d.defenderName : d.attackerName);
        var k = arKey(r);
        if (seen[k]) { if (!seen[k].nm) seen[k] = Object.assign({}, seen[k], { nm: r.nm }); return; }
        seen[k] = r;
      });
      var recs = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (x, y) { return x.t - y.t; });
      var t = pv ? pvTotals(pv) : null;
      var x = pxExtract({ squad: squad, roster: roster }, me, recs, t ? { p: t.precision, e: t.evasion } : null);
      return { app: 'PvP Meta', v: 1, ver: scriptVersion(), realm: REALM, made: Date.now(), root: st ? plRoot(st) : null, duels: recs, x: x };
    });
  }

  function plB64(bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // 'z' + deflate, base64url; 'j' + plain JSON where the browser cannot compress.
  function plEncode(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'function') return Promise.resolve('j' + plB64(bytes));
    var cs = new CompressionStream('deflate-raw'), w = cs.writable.getWriter();
    w.write(bytes).catch(function () {}); w.close().catch(function () {});
    return new Response(cs.readable).arrayBuffer().then(function (buf) { return 'z' + plB64(new Uint8Array(buf)); });
  }

  // A data set too big for a link is handed over by message once the page
  // says it is ready, and only to the planner's own address.
  var plPending = null;
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!plPending || e.origin !== PLANNER_ORIGIN || !d || d.sopvpReady !== plPending.nonce || !e.source) return;
    try { e.source.postMessage({ sopvpData: plPending.obj, nonce: plPending.nonce }, PLANNER_ORIGIN); } catch (er) { PL.err = 'handing the data over failed: ' + er.message; }
    plPending = null;
  });

  // The new tab is opened at the click itself (a tab opened later would be
  // blocked as a pop-up), then sent on once the data is ready.
  function plOpen() {
    if (PL.busy) return;
    PL.busy = true; PL.err = null; PL.link = null;
    var w = null;
    try {
      w = window.open('', '_blank');
      if (w) { w.document.title = 'PvP Build Planner'; w.document.body.style.cssText = 'font:14px sans-serif;padding:20px;background:#1a2129;color:#ccd'; w.document.body.textContent = 'Getting your duels and battles ready...'; }
    } catch (e) {}
    render();
    plPayload().then(function (obj) {
      return plEncode(obj).then(function (code) {
        var url;
        if (code.length <= PL_MAX_URL) url = PLANNER_URL + '#data=' + code;
        else { var nonce = String(Math.random()).slice(2); plPending = { nonce: nonce, obj: obj }; url = PLANNER_URL + '#wait=' + nonce; }
        PL.last = { n: obj.x.players.length, b: obj.x.battles.length, d: obj.duels.length, kb: Math.round(code.length / 1024) };
        if (w && !w.closed) { try { w.location.replace(url); } catch (e) { PL.link = url; } }
        else PL.link = url;
      });
    }).catch(function (e) {
      PL.err = 'Preparing the data failed: ' + ((e && e.message) || e);
      try { if (w && !w.closed) w.document.body.textContent = PL.err; } catch (er) {}
    }).then(function () { PL.busy = false; render(); });
  }

  function plRow() {
    var h = '<div class="row"><button class="act" id="b_plopen"' + (PL.busy ? ' disabled' : '') + '>' + (PL.busy ? 'Preparing...' : 'Open in planner ↗') + '</button></div>';
    if (PL.link) h += '<div class="line">Your browser blocked the new tab. <a href="' + esc(PL.link) + '" target="_blank" rel="noopener">Open the planner</a></div>';
    if (PL.err) h += line(PL.err, 'bad');
    if (PL.last && !PL.busy) h += line('Sent ' + PL.last.d + ' duels and ' + PL.last.n + ' players from ' + PL.last.b + ' squadron battles (' + PL.last.kb + ' KB), inside the link only: no server sees them.', 'mu');
    return h;
  }

  // The main view, with the planner button under each tab.
  function renderBattle() {
    var pv = S.storeOk ? readPvp(S.storeState) : null;
    if (!pv) return '<div class="empty">The battlefield data is not readable yet.</div>' + plRow();
    var h = subTabs();
    if (bsub === 'fights') return h + renderFights().replace('not saved', 'kept from 1.2.0 on') + plRow();
    var plan = pvRequest(pv);
    if (bsub === 'best') return h + renderBest(pv, plan) + plRow();
    if (bsub === 'up') return h + renderUp(pv, plan) + plRow();
    return h + renderCur(pv, plan) + plRow();
  }

  /* ============================================================
     FROM ASTROLABE 3.22.8 (copied unchanged by the build step)
     ============================================================ */

  var AR_MAX = 200;

  function clamp(lo, hi, v) { return v < lo ? lo : (v > hi ? hi : v); }

  function numOr(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') {
      var m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      if (m) return parseFloat(m[0]);
    }
    return null;
  }

  function fmt(x, dp) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    var a = Math.abs(x);
    if (a >= 1e12) return (x / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (x / 1e3).toFixed(2) + 'k';
    return Number(x).toFixed(dp === undefined ? 1 : dp);
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function unwrap(o) { try { return (o && o.wrappedJSObject) || o; } catch (e) { return o; } }

  var vueApp = null;

  function findVueApp() {
    try { if (vueApp && vueApp._container && document.contains(vueApp._container)) return vueApp; } catch (e) {}
    vueApp = null;
    var roots = [];
    ['#app', '#q-app', '#__nuxt', '#root', 'body > div'].forEach(function (sel) {
      try { document.querySelectorAll(sel).forEach(function (n) { roots.push(n); }); } catch (e) {}
    });
    try { document.querySelectorAll('body div').forEach(function (n, i) { if (i < 60) roots.push(n); }); } catch (e) {}
    for (var i = 0; i < roots.length; i++) {
      var el = unwrap(roots[i]);
      try { if (el && el.__vue_app__) { vueApp = el.__vue_app__; return vueApp; } } catch (e) {}
    }
    return null;
  }

  function findPinia() {
    var app = findVueApp();
    if (!app) return null;
    try {
      var gp = app.config && app.config.globalProperties;
      if (gp && gp.$pinia) return gp.$pinia;
    } catch (e) {}
    try {
      var prov = app._context && app._context.provides;
      if (prov) {
        var syms = Object.getOwnPropertySymbols(prov);
        for (var i = 0; i < syms.length; i++) {
          if (String(syms[i]).toLowerCase().indexOf('pinia') >= 0) return prov[syms[i]];
        }
        for (var j = 0; j < syms.length; j++) {
          var cand = prov[syms[j]];
          if (cand && cand.state && cand.state.value) return cand;
        }
      }
    } catch (e) {}
    return null;
  }

  function matList(root) {
    var out = [];
    try {
      var L = root.MaterialsStore.materialsList;
      if (!Array.isArray(L)) return out;
      L.forEach(function (m) {
        var it = m && m.item, nm = typeof it === 'string' ? it : (it && typeof it.name === 'string' ? it.name : null);
        if (nm) out.push({ name: nm, cat: it && typeof it === 'object' ? it.category : null, q: numOr(m.quantity) || 0 });
      });
    } catch (e) {}
    return out;
  }

  function matsHeld(root) {
    var o = {};
    matList(root).forEach(function (m) { o[m.name.toLowerCase()] = m.q; });
    return o;
  }

  function slottedPetLevel(root, name) {
    try {
      var P = root.PetsStore, inSlot = {}, lv = null;
      (P.petSlots || []).forEach(function (s) { if (s && s.pet) inSlot[s.pet] = 1; });
      (P.pets || []).forEach(function (p) { if (lv === null && p && p.name === name && inSlot[p._id]) lv = numOr(p.level) || 0; });
      return lv;
    } catch (e) { return null; }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function scriptVersion() { try { return GM_info.script.version; } catch (e) { return '?'; } }

  var PVP_STATS = ['power', 'precision', 'evasion', 'hull'];

  var PVP_SKILLS = ['dot', 'focus', 'stun', 'block'];

  var PVP_HP_MULT = 7;

  var CLONE_CRIT_BASE = 30;

  function readPvp(root) {
    try {
      var P = root.UserStore.player, gear = P.pvp_gear, ps = P.pvpstats;
      if (!Array.isArray(gear) || !gear.length || !ps) return null;
      var pts = {}, pool = numOr(ps.available) || 0;
      PVP_STATS.forEach(function (s) { pts[s] = numOr(ps[s]) || 0; pool += pts[s]; });
      var craft = 0;
      try { craft = numOr(root.CraftStore.crafting_level) || 0; } catch (e) {}
      var vel = (slottedPetLevel(root, 'Velari') || 0) * 50;
      var mats = matsHeld(root);
      var clones = (P.clones || []).map(function (c) {
        return { crit: (numOr(c.critical_chance) || 0) / 100, cm: 1 + (CLONE_CRIT_BASE + (numOr(c.critical_damage) || 0)) / 100, dual: (numOr(c.dual_shot) || 0) / 100 };
      });
      var badges = 0;
      try { badges = numOr(root.UserStore.pvp_badges) || 0; } catch (e) {}
      return {
        pts: pts, pool: pool, craft: craft, vel: vel, mats: mats, badges: badges, clones: clones, N: Math.max(1, clones.length),
        gear: gear.map(function (g) {
          return { name: String(g.name), stat: g.stat, skill: g.skill, L: numOr(g.statLevel) || 0, T: numOr(g.statTier) || 0, mat: String(g.statCost || '').toLowerCase() };
        })
      };
    } catch (e) { return null; }
  }

  function pvCopy(b) {
    var o = Object.assign({}, b);
    o.pts = Object.assign({}, b.pts);
    o.gear = b.gear.map(function (g) { return Object.assign({}, g); });
    o.mats = Object.assign({}, b.mats);
    return o;
  }

  function pvGearVal(g, craft) { return 100 * g.L * (1 + g.T / 100 + craft / 100); }

  function pvLevelCost(L) { return 20 * (L + 1) * (L + 2); }

  function pvTierCost(T) { return 10 * (T + 1) * (T + 2); }

  function pvGearBase(b) {
    var t = { power: b.vel, precision: b.vel, evasion: b.vel, hull: b.vel };
    b.gear.forEach(function (g) { if (t[g.stat] !== undefined) t[g.stat] += pvGearVal(g, b.craft); });
    return t;
  }

  function pvTotals(b) {
    var t = pvGearBase(b);
    PVP_STATS.forEach(function (s) { t[s] += b.pts[s] || 0; });
    t.damage = Math.floor(t.power * b.N);
    t.hp = Math.floor(t.hull * b.N * PVP_HP_MULT);
    return t;
  }

  function pvSkills(gear) {
    var c = { dot: 0, focus: 0, stun: 0, block: 0 };
    gear.forEach(function (g) { if (c[g.skill] !== undefined) c[g.skill] += g.skill === 'focus' ? 0.025 : 0.05; });
    return c;
  }

  function pvTerm(s, x, ref) {
    x = Math.max(x, 1);
    if (s === 'precision') return Math.log(x) - Math.log(x + ref.evasion);
    if (s === 'evasion') return Math.log(ref.precision + x);
    return Math.log(x);
  }

  function pvAllocate(b, ref) {
    var base = pvGearBase(b), pool = Math.max(0, Math.round(b.pool)), R = ref.evasion, Q = ref.precision;
    function level(s, lam) {
      if (s === 'precision') return R > 0 ? (-R + Math.sqrt(R * R + 4 * R / lam)) / 2 : 0;
      if (s === 'evasion') return 1 / lam - Q;
      return 1 / lam;
    }
    function want(lam) {
      var t = 0;
      PVP_STATS.forEach(function (s) { t += Math.max(0, level(s, lam) - base[s]); });
      return t;
    }
    var lo = 1e-12, hi = 1, i;
    for (i = 0; i < 90; i++) { var mid = Math.sqrt(lo * hi); if (want(mid) > pool) lo = mid; else hi = mid; }
    var pts = {}, used = 0;
    PVP_STATS.forEach(function (s) { pts[s] = Math.max(0, Math.floor(level(s, hi) - base[s])); used += pts[s]; });
    while (used > pool) {   // rounding guard
      var big = PVP_STATS.slice().sort(function (x, y) { return pts[y] - pts[x]; })[0];
      pts[big]--; used--;
    }
    while (used < pool) {
      var best = null, bg = -Infinity;
      PVP_STATS.forEach(function (s) {
        var x = base[s] + pts[s], g = pvTerm(s, x + 1, ref) - pvTerm(s, x, ref);
        if (g > bg) { bg = g; best = s; }
      });
      pts[best]++; used++;
    }
    return pts;
  }

  function pvScore(b, ref) {
    var t = pvTotals(b);
    return pvTerm('power', t.power, ref) + pvTerm('hull', t.hull, ref) + pvTerm('precision', t.precision, ref) + pvTerm('evasion', t.evasion, ref);
  }

  function pvBestAssign(b, ref) {
    var n = b.gear.length, total = Math.pow(PVP_STATS.length, n), best = null;
    for (var a = 0; a < total; a++) {
      var c = pvCopy(b), x = a;
      for (var i = 0; i < n; i++) { c.gear[i].stat = PVP_STATS[x % PVP_STATS.length]; x = Math.floor(x / PVP_STATS.length); }
      c.pts = pvAllocate(c, ref);
      c.score = pvScore(c, ref);
      if (!best || c.score > best.score + 1e-12) best = c;
    }
    return best;
  }

  function pvSpend(b, keepBadges) {
    var g2 = b.gear.map(function (g) { return Object.assign({}, g); }), mats = Object.assign({}, b.mats), badges = Math.max(0, b.badges - Math.max(0, keepBadges || 0));
    var steps = [];
    g2.forEach(function (g, i) {
      var from = g.L, cost = 0;
      while ((mats[g.mat] || 0) >= pvLevelCost(g.L)) { var c = pvLevelCost(g.L); mats[g.mat] -= c; cost += c; g.L++; }
      if (g.L > from) steps.push({ i: i, name: g.name, kind: 'level', from: from, to: g.L, cost: cost, res: g.mat });
    });
    var tierFrom = g2.map(function (g) { return g.T; }), tierCost = g2.map(function () { return 0; });
    for (;;) {
      var pick = -1, br = Infinity;
      g2.forEach(function (g, i) { var c = pvTierCost(g.T); if (c <= badges && g.L > 0 && c / g.L < br) { br = c / g.L; pick = i; } });
      if (pick < 0) break;
      var c2 = pvTierCost(g2[pick].T); badges -= c2; tierCost[pick] += c2; g2[pick].T++;
    }
    g2.forEach(function (g, i) { if (g.T > tierFrom[i]) steps.push({ i: i, name: g.name, kind: 'tier', from: tierFrom[i], to: g.T, cost: tierCost[i], res: 'badges' }); });
    return { gear: g2, steps: steps };
  }

  function rngStreams(seed, names) {
    var out = {};
    names.forEach(function (n, k) { out[n] = btRng((seed | 0) ^ Math.imul(k + 1, 0x9E3779B9)); });
    return out;
  }

  function rcFit(obs, kind) {
    var n = 0;
    obs.forEach(function (o) { n += o.n; });
    if (n < 12) return null;
    var best = -Infinity, arg = null;
    for (var k = 0; k <= 140; k++) {
      var q = Math.exp(Math.log(20) + k * (Math.log(30000) - Math.log(20)) / 140), ll = 0;
      for (var i = 0; i < obs.length; i++) {
        var o = obs[i], p = kind === 'p' ? q / (q + o.o) : o.o / (o.o + q), x = o.x + 0.5, t = o.n + 1;
        ll += x * Math.log(p) + (t - x) * Math.log(1 - p);
      }
      if (ll > best) { best = ll; arg = q; }
    }
    return arg;
  }

  function arOwner(name) { var m = /^(.*)'s Clone \d+$/.exec(String(name || '')); return m ? m[1] : null; }

  function arIndex(name) { var m = /^.*'s Clone (\d+)$/.exec(String(name || '')); return m ? +m[1] : 0; }

  function arHp(s) { var m = /(-?\d+)\s*\/\s*(\d+)/.exec(String(s || '')); return m ? { hp: +m[1], max: +m[2] } : null; }

  function arRound1(x) { return Math.round(x * 10) / 10; }

  function arDamage(vals) {
    var none = { base: 0, crit: 0, cm: 1.3, dual: 0 };
    if (!vals.length) return none;
    var base = Infinity;
    vals.forEach(function (v) { var k = Math.round(v); if (k > 0 && k < base) base = k; });
    if (!isFinite(base)) return none;
    var r = vals.map(function (v) { return v / base; }), TOL = 0.006;
    function near(x, y) { return Math.abs(x - y) <= y * TOL; }
    // [factor, crit shots, dual] for one line, or null when c does not explain it
    function read(x, c) {
      if (near(x, 1)) return [0, 0];
      if (near(x, 2)) return [0, 1];
      if (near(x, c)) return [1, 0];
      if (near(x, 1 + c)) return [1, 1];
      if (near(x, 2 * c)) return [2, 1];
      return null;
    }
    var bestC = 1.3, bestN = -1;
    for (var c = 1.30; c <= 3.5; c += 0.002) {
      if (Math.abs(c - 2) < 0.02) continue;   // a crit of x2 cannot be told from a dual shot
      var n = 0;
      for (var i = 0; i < r.length; i++) if (read(r[i], c)) n++;
      if (n > bestN) { bestN = n; bestC = c; }
    }
    // The grid step leaves c a little off: take the average c the crit
    // lines themselves imply.
    var cs = 0, cn = 0;
    r.forEach(function (x) {
      var k = read(x, bestC);
      if (!k || !k[0]) return;
      cs += k[0] === 2 ? x / 2 : (k[1] ? x - 1 : x); cn++;
    });
    if (cn) bestC = cs / cn;
    var lines = 0, shots = 0, crits = 0, duals = 0;
    r.forEach(function (x) {
      var k = read(x, bestC);
      if (!k) return;
      lines++; shots += 1 + k[1]; crits += k[0]; duals += k[1];
    });
    if (!lines) return { base: base, crit: 0, cm: 1.3, dual: 0 };
    return { base: base, crit: arRound1(crits / shots * 100), cm: crits ? Math.round(bestC * 1000) / 1000 : 1.3, dual: arRound1(duals / lines * 100), lines: lines, duals: duals };
  }

  function arBuild(duel, me, pv, nowMs) {
    try {
      if (!duel || !duel.logs || !duel.logs.length || !me) return null;
      if (duel.attackerName !== me && duel.defenderName !== me) return null;
      var them = duel.attackerName === me ? duel.defenderName : duel.attackerName;
      if (!them) return null;

      var side = {}, rounds = 0, first = null;
      function get(n) { return side[n] || (side[n] = { n: 0, max: 0, dmg: [], hit: 0, miss: 0, blocked: 0, att: 0, dot: 0, stun: 0, focus: 0, dual: 0, out: 0, seen: {} }); }

      duel.logs.forEach(function (e) {
        if (e.action === 'round') { rounds = numOr(e.value) || rounds; return; }
        var ao = arOwner(e.attacker), dO = arOwner(e.defender);
        if (dO) { var d = get(dO); d.n = Math.max(d.n, arIndex(e.defender)); var h = arHp(e.hpLeft); if (h) d.max = Math.max(d.max, h.max); }
        if (ao) { var a = get(ao); a.n = Math.max(a.n, arIndex(e.attacker)); }
        if (e.action === 'dies') { if (dO) get(dO).out = rounds; return; }
        if (!ao) return;
        var A = get(ao);
        if (e.action === 'attacks' || e.action === 'misses hit on' || e.action === 'attack blocked') {
          if (first === null) first = ao;
          A.att++;
          if (e.action === 'attacks') {
            A.hit++;
            // a killing blow is capped at the health left, so it says nothing about the hit
            var v = numOr(e.value), hl = arHp(e.hpLeft);
            if (v !== null && v > 0 && !(hl && hl.hp <= 0)) A.dmg.push(v);
          }
          else if (e.action === 'attack blocked') { A.hit++; get(dO || ao).blocked++; }
          else A.miss++;
          // A dual shot is one log line holding both shots; arDamage reads it.
        } else if (e.action === 'applies DoT') A.dot++;
        else if (e.action === 'stuns') A.stun++;
        else if (e.action === 'focused') A.focus++;
      });

      var mine = side[me], theirs = side[them];
      if (!mine || !theirs || !mine.n || !theirs.n || !mine.max || !theirs.max) return null;

      // Our own stats are known exactly, so the opponent's precision comes
      // from how often it hit us, and its evasion from how often we hit it.
      var t = pv ? pvTotals(pv) : null;
      var myP = t ? Math.round(t.precision) : null, myE = t ? Math.round(t.evasion) : null;
      if (myP === null) return null;

      function fit(hits, swings, known, kind) {
        if (swings < 12) return null;
        return rcFit([{ x: hits, n: swings, o: known }], kind);
      }
      var opP = fit(theirs.hit, theirs.att, myE, 'p');
      var opE = fit(mine.hit, mine.att, myP, 'e');

      function skills(s, other) {
        function pc(x, n) { return Math.min(60, arRound1(x / (n + 4) * 100)); }
        return [pc(s.dot, s.att), pc(s.focus, s.att), pc(s.stun, s.att), pc(s.blocked, other.hit + 0)];
      }
      // The log shows a dual line only when the second shot also lands
      // unblocked, so the stat is the share seen divided by that chance,
      // pulled towards a typical 35% while there are few lines to go on (as
      // if 30 lines at 35% had been seen) and capped at 60%, above anything
      // seen live.
      function dualStat(s, other, dmg) {
        var p2 = Math.max(0.05, (s.hit - other.blocked) / Math.max(1, s.att)), K = 30;
        if (!dmg.lines) return 0;
        return arRound1(Math.min(60, (dmg.duals + 0.35 * p2 * K) / (p2 * (dmg.lines + K)) * 100));
      }
      function fighter(s, other, dmg, p, e) {
        return { n: s.n, d: dmg.base, h: s.max, p: p, e: e,
          s: skills(s, other), c: [[dmg.crit, arRound1((dmg.cm - 1) * 100 - 30), dualStat(s, other, dmg)]],
          x: s.out || 0,
          // how the hit counts came out, so a later reader can tell a
          // precision read off 12 swings from one read off 120
          q: [s.hit, s.att, other.hit, other.att] };
      }
      var myDmg = arDamage(mine.dmg), opDmg = arDamage(theirs.dmg);

      // Did the build that fought this duel still look like today's build?
      var approx = 0;
      if (t) {
        var expD = t.power * mine.n, expH = t.hull * PVP_HP_MULT * mine.n;
        if (Math.abs(myDmg.base / expD - 1) > 0.02 || Math.abs(mine.max / expH - 1) > 0.02) approx = 1;
      }

      var out = {
        v: 3, t: (numOr(duel.created) || 0) * 1000 || nowMs, i: typeof duel._id === 'string' ? duel._id : null,
        w: duel.winner === me ? 1 : 0, f: first === me ? 1 : 0, r: rounds,
        o: fighter(mine, theirs, myDmg, myP, myE),
        e: fighter(theirs, mine, opDmg, opP === null ? myP : Math.round(opP), opE === null ? myE : Math.round(opE))
      };
      if (opP === null || opE === null) out.e.u = 1;
      if (approx) out.a = 1;
      return out;
    } catch (e) { return null; }
  }

  function arKey(rec) {
    if (rec.i) return rec.i;
    return rec.r + '|' + rec.w + '|' + rec.o.d + ':' + rec.o.h + '|' + rec.e.d + ':' + rec.e.h;
  }

  var AR_SPREAD = [-1.15, -0.5, 0, 0.5, 1.15];

  var AR_ASSUME = 24;

  function arAssume(f, pRef, eRef) {
    var hitUs = f.p / (f.p + eRef), hitThem = pRef / (pRef + f.e);
    return [Math.round(hitUs * AR_ASSUME), AR_ASSUME, Math.round(hitThem * AR_ASSUME), AR_ASSUME];
  }

  function arDraws(f, pRef, eRef) {
    var q = (f.q && f.q.length >= 4) ? f.q : null, out = [];
    pRef = pRef || f.p; eRef = eRef || f.e;
    if (!q) { try { q = arAssume(f, pRef, eRef); } catch (e) { return [arSide(f)]; } }
    for (var j = 0; j < 4; j++) if (numOr(q[j]) === null || q[j] < 0) return [arSide(f)];
    if (!(q[1] > 0) || !(q[3] > 0)) return [arSide(f)];
    // hits out of swings is a coin flip repeated, so the spread of the
    // underlying rate is the usual sqrt(p(1-p)/n).
    function stat(hits, swings, known, invert) {
      var p = Math.min(0.98, Math.max(0.02, hits / Math.max(1, swings)));
      var se = Math.sqrt(p * (1 - p) / Math.max(1, swings));
      var v = AR_SPREAD.map(function (z) {
        var q2 = Math.min(0.98, Math.max(0.02, p + z * se));
        return invert ? known * (1 - q2) / q2 : known * q2 / (1 - q2);
      });
      // Turning a hit rate back into a stat bends the scale, so an even
      // spread of rates comes out lopsided in stat points. Recentre on the
      // plain estimate: the doubt is kept, the drift is not.
      var mean = 0, mid = v[(AR_SPREAD.length - 1) >> 1];
      v.forEach(function (x) { mean += x; });
      mean /= v.length;
      var k = mean > 0 ? mid / mean : 1;
      return v.map(function (x) { return x * k; });
    }
    var P = stat(q[0], q[1], eRef, false);   // their precision, against our evasion
    var E = stat(q[2], q[3], pRef, true);    // their evasion, against our precision
    for (var i = 0; i < AR_SPREAD.length; i++) {
      var s = arSide(f);
      s.prec = Math.max(20, Math.round(P[i]));
      s.eva = Math.max(20, Math.round(E[i]));
      out.push(s);
    }
    return out;
  }

  function arSide(f) {
    var sk = (f && Array.isArray(f.s) && f.s.length === 4) ? f.s : [0, 0, 0, 0];
    var cl = (f && Array.isArray(f.c) && f.c.length) ? f.c : [[0, 0, 0]];
    function num(v, d) { var x = numOr(v); return x === null ? d : x; }
    return {
      N: Math.max(1, num(f && f.n, 1)), hp: Math.max(1, num(f && f.h, 1)), dmg: Math.max(0, num(f && f.d, 0)),
      prec: Math.max(1, num(f && f.p, 1)), eva: Math.max(1, num(f && f.e, 1)),
      sk: { dot: num(sk[0], 0) / 100, focus: num(sk[1], 0) / 100, stun: num(sk[2], 0) / 100, block: num(sk[3], 0) / 100 },
      cl: cl.map(function (c) {
        c = (Array.isArray(c) && c.length) ? c : [0, 0, 0];
        return { crit: num(c[0], 0) / 100, cm: 1 + (30 + num(c[1], 0)) / 100, dual: num(c[2], 0) / 100 };
      })
    };
  }

  var RL_MAX_ROUNDS = 300;

  var RL_MAX_CLONES = 64;

  function rlSlot() {
    return { S: null, hp: new Float64Array(RL_MAX_CLONES), ch: new Int8Array(RL_MAX_CLONES),
      st: new Uint8Array(RL_MAX_CLONES), mark: -1, alive: 0 };
  }

  var RL_A = rlSlot();

  var RL_B = rlSlot();

  function rlLoad(f, S) {
    f.S = S; f.mark = -1; f.alive = Math.min(S.N, RL_MAX_CLONES);
    for (var i = 0; i < f.alive; i++) { f.hp[i] = S.hp; f.ch[i] = 0; f.st[i] = 0; }
  }

  function rlPhase(a, d, R) {
    var S = a.S, T = d.S, n = a.alive ? S.N : 0, i, dual, cl, t, k, pick, dmg, base, rHit, rBlock, rCrit, rCrit2, rDot, rStun, rFocus, rHit2, rBlock2;
    for (i = 0; i < n; i++) {
      if (d.alive <= 0) return;
      if (a.hp[i] <= 0) continue;
      if (a.st[i]) { a.st[i] = 0; continue; }
      cl = S.cl[i % S.cl.length];
      dual = R.dual() < cl.dual;
      pick = Math.floor(R.pick() * d.alive);
      rHit = R.hit(); rBlock = R.block(); rCrit = R.crit(); rCrit2 = R.crit2(); rDot = R.dot(); rStun = R.stun(); rFocus = R.focus();
      rHit2 = R.hit2(); rBlock2 = R.block2();
      // The second shot of a dual rolls its own hit and block: dual-shot
      // lines run at the stated chance x the shooter's hit rate x (1 -
      // block), 512 seen for 507 predicted over 38 players (live, 2026-11-08).
      if (dual && (rHit2 >= S.prec / (S.prec + T.eva) || (T.sk.block > 0 && rBlock2 < T.sk.block))) dual = false;
      if (d.mark >= 0 && d.hp[d.mark] > 0) t = d.mark;
      else {
        t = -1;
        for (k = 0; k < T.N; k++) if (d.hp[k] > 0) { if (pick === 0) { t = k; break; } pick--; }
      }
      if (rHit >= S.prec / (S.prec + T.eva)) continue;
      base = S.dmg;
      if (S.sk.focus > 0 && d.mark < 0 && rFocus < S.sk.focus) d.mark = t;
      if (S.sk.dot > 0 && rDot < S.sk.dot) d.ch[t] = 3;
      if (d.ch[t] > 0) {
        d.ch[t]--; d.hp[t] -= Math.floor(base * 0.5);
        if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; continue; }
      }
      if (T.sk.block > 0 && rBlock < T.sk.block) continue;
      dmg = Math.floor(base * ((rCrit < cl.crit ? cl.cm : 1) + (dual ? (rCrit2 < cl.crit ? cl.cm : 1) : 0)));
      d.hp[t] -= dmg;
      if (d.hp[t] <= 0) { d.alive--; if (d.mark === t) d.mark = -1; }
      else if (S.sk.stun > 0 && !d.st[t] && rStun < S.sk.stun) d.st[t] = 1;
    }
  }

  function rlLeft(f) {
    if (f.alive <= 0) return 0;
    var s = 0, i;
    for (i = 0; i < f.S.N; i++) if (f.hp[i] > 0) s += f.hp[i];
    return s / (f.S.N * f.S.hp);
  }

  function rlDuel(SA, SB, aFirst, seed) {
    var A = RL_A, B = RL_B, first, second, r;
    var R = rngStreams(seed, ['dual', 'pick', 'hit', 'block', 'crit', 'dot', 'stun', 'focus', 'crit2', 'hit2', 'block2']);
    rlLoad(A, SA); rlLoad(B, SB);
    first = aFirst ? A : B; second = aFirst ? B : A;
    for (r = 1; r <= RL_MAX_ROUNDS && A.alive > 0 && B.alive > 0; r++) {
      rlPhase(first, second, R);
      if (second.alive <= 0) break;
      rlPhase(second, first, R);
    }
    var la = rlLeft(A), lb = rlLeft(B);
    // After 300 rounds the side with more health left wins; a tie goes to the
    // defender, the side that strikes first (the game's arena wiki).
    return { win: B.alive <= 0 ? 1 : (A.alive <= 0 ? 0 : (la > lb ? 1 : (la < lb ? 0 : (aFirst ? 1 : 0)))),
      rounds: r > RL_MAX_ROUNDS ? RL_MAX_ROUNDS : r, fracA: la, fracB: lb };
  }

  function rlMe(b) {
    var t = pvTotals(b);
    return { N: b.N, hp: t.hull * PVP_HP_MULT * b.N, dmg: t.power * b.N, prec: t.precision, eva: t.evasion, sk: pvSkills(b.gear),
      cl: b.clones.length ? b.clones : [{ crit: 0, cm: 1 + CLONE_CRIT_BASE / 100, dual: 0 }] };
  }

  var PV_SIMS = 1200;

  var PV_MIN_EACH = 10;

  var PV_MAX_BATTLES = 2000;

  var PV_SEED = 7;

  var PV_FLOOR = 8;

  var PV_CONTESTED = 3;

  var PV_DECIDED = 0.02;

  function pvPool(recs) {
    var out = [];
    recs.forEach(function (r) {
      if (!r || !r.e || !r.o) return;
      out.push(arDraws(r.e, r.o.p, r.o.e));
    });
    return out;
  }

  var PV_META = [
    { f: [0.35, 0.15, 0.15, 0.35], sk: ['block', 'block', 'block', 'block'], w: 0.45 },
    { f: [0.35, 0.15, 0.15, 0.35], sk: ['dot', 'block', 'block', 'block'], w: 0.25 },
    { f: [0.35, 0.15, 0.20, 0.30], sk: ['block', 'block', 'block', 'block'], w: 0.15 },
    { f: [0.30, 0.15, 0.20, 0.35], sk: ['dot', 'dot', 'block', 'block'], w: 0.15 }
  ];

  var PV_NAIVE_BEST = [0.35, 0.20, 0.10, 0.35];

  var PV_META_COPIES = 20;

  function pvMetaPool(b) {
    var t = pvTotals(b), budget = t.power + t.precision + t.evasion + t.hull, me = rlMe(b), out = [];
    PV_META.forEach(function (m) {
      var sk = { dot: 0, focus: 0, stun: 0, block: 0 };
      m.sk.forEach(function (s) { sk[s] += s === 'focus' ? 0.025 : 0.05; });
      var p = m.f.map(function (x) { return Math.max(1, Math.round(x * budget)); });
      var side = { N: b.N, hp: p[3] * PVP_HP_MULT * b.N, dmg: p[0] * b.N, prec: p[1], eva: p[2], sk: sk, cl: me.cl };
      for (var i = 0; i < Math.round(m.w * PV_META_COPIES); i++) out.push([side]);
    });
    return out;
  }

  function pvPoolRef(pool) {
    var p = 0, e = 0, n = 0;
    pool.forEach(function (draws) { draws.forEach(function (s) { p += s.prec; e += s.eva; n++; }); });
    return { precision: p / (n || 1), evasion: e / (n || 1) };
  }

  function pvPlanKey(pv, keepBadges, recs) {
    // Only the materials the gear is levelled with: keying on every material
    // held re-ran the whole plan each time any unrelated drop landed.
    var mats = pv.gear.map(function (g) { return pv.mats[g.mat] || 0; });
    return JSON.stringify([pv.pts, pv.pool, pv.gear, pv.craft, pv.vel, pv.N, pv.clones, mats, pv.badges, keepBadges, recs.map(arKey)]);
  }

  function pvScoreOf(b, pool, sims) {
    var me = rlMe(b), n = pool.length || 1;
    // Sims per opponent. The floor keeps each opponent's own win rate
    // meaningful; the ceiling on the total keeps one call from blocking the
    // page when there are a lot of duels on record. Between them the cost of
    // a scoring call is bounded whatever the pool size.
    var each = Math.max(PV_MIN_EACH, Math.round((sims || PV_SIMS) / n));
    if (n * each > PV_MAX_BATTLES) each = Math.max(PV_MIN_EACH, Math.floor(PV_MAX_BATTLES / n));
    var per = [], w = 0, m = 0, rounds = 0;
    for (var k = 0; k < pool.length; k++) {
      var draws = pool[k], ww = 0, mm = 0, rr = 0;
      for (var i = 0; i < each; i++) {
        var r = rlDuel(me, draws[i % draws.length], i % 2 === 0, PV_SEED + k * 104729 + i * 7919);
        ww += r.win; mm += r.fracA - r.fracB; rr += r.rounds;
      }
      per.push(ww / each);
      w += ww / each; m += mm / each; rounds += rr / each;
    }
    w /= n; m /= n; rounds /= n;
    var v = 0;
    per.forEach(function (x) { v += (x - w) * (x - w); });
    return { score: w * 100 + m, win: w, rounds: rounds, per: per,
      se: per.length > 1 ? Math.sqrt(v / (per.length - 1) / per.length) * 100 : 50 };
  }

  function pvGap(a, b) {
    var n = Math.min(a.per.length, b.per.length), d = [], sum = 0, i;
    if (!n) return { gain: 0, se: 50 };
    for (i = 0; i < n; i++) { d.push((b.per[i] - a.per[i]) * 100); sum += d[i]; }
    var mean = sum / n, v = 0;
    for (i = 0; i < n; i++) v += (d[i] - mean) * (d[i] - mean);
    return { gain: mean, se: n > 1 ? Math.sqrt(v / (n - 1) / n) : 50 };
  }

  function pvNeedFor(se, n, target) {
    if (!(se > target) || !(n > 0)) return 0;
    return Math.max(1, Math.ceil(n * (se / target) * (se / target)) - n);
  }

  function pvPct(score) { return Math.max(0, Math.min(100, Math.round(score))); }

  function pvCompositions(n) {
    var out = [];
    (function rec(start, cur) {
      if (cur.length === n) { out.push(cur.slice()); return; }
      for (var i = start; i < PVP_SKILLS.length; i++) { cur.push(PVP_SKILLS[i]); rec(i, cur); cur.pop(); }
    })(0, []);
    return out;
  }

  function pvUpgradeRows(b, pool, base, i, only) {
    var g = b.gear[i], rows = [];
    (only ? [only] : ['level', 'tier']).forEach(function (kind) {
      var c = pvCopy(b);
      if (kind === 'level') c.gear[i].L++; else c.gear[i].T++;
      rows.push({ name: g.name, kind: kind, from: kind === 'level' ? g.L : g.T, cost: kind === 'level' ? pvLevelCost(g.L) : pvTierCost(g.T),
        res: kind === 'level' ? g.mat : 'badges', have: kind === 'level' ? (b.mats[g.mat] || 0) : b.badges,
        gain: pool ? pvScoreOf(c, pool, 800).score - base : null });
    });
    return rows;
  }

  var PV_SEARCH_MAX = 40;

  function pvSample(list, max) {
    var n = list.length;
    if (n <= max) return list;
    var out = [], step = n / max, i;
    for (i = 0; i < max; i++) out.push(list[Math.min(n - 1, Math.floor(i * step))]);
    return out;
  }

  function pvPlanRun(pv, recs, keepBadges, done) {
    try {
      var pool = pvPool(recs), synthetic = pool.length < PV_FLOOR;
      // Too few real opponents to tune against: the meta field at the player's
      // own total stat stands in (pvMetaPool), and the plan says so.
      var plan = { pool: pool.length, floor: PV_FLOOR, thin: synthetic, synthetic: synthetic };
      if (synthetic) pool = pvMetaPool(pv);
      var ref = pvPoolRef(pool);
      plan.ref = ref;
      plan.cur = pvScoreOf(pv, pool);
      plan.need = synthetic ? 0 : pvNeedFor(plan.cur.se, pool.length, 5);
      // A fight you always win, or always lose, says nothing about which
      // build is better: every build gets the same result. Tuning is done
      // on the ones that could go either way.
      var idx = [];
      plan.cur.per.forEach(function (w, i) { if (w > PV_DECIDED && w < 1 - PV_DECIDED) idx.push(i); });
      plan.contested = idx.length;
      plan.decided = pool.length - idx.length;
      var liveAll = idx.map(function (i) { return pool[i]; });   // all the contested: what the finalists are settled on
      // The meta field is at the player's own budget, so its fights are
      // contested by construction; should a build still settle them all,
      // tune on the whole field rather than stop.
      if (synthetic && idx.length < PV_CONTESTED) liveAll = pool;
      else if (idx.length < PV_CONTESTED) { plan.stop = 1; done(plan); return; }
      var live = pvSample(liveAll, PV_SEARCH_MAX);   // a sample of them: what the search runs on
      plan.searched = live.length;

      // The split of points and each piece's active stat from the formula...
      var cand = pvBestAssign(pv, ref);
      // ...then the skills by running the duels. Stun and Focus lose at equal
      // budget whatever they are paired with (the self-play meta), so sets
      // with two or more of them are not tried: 35 compositions become 13.
      // The current skills always compete, whatever they are, so a recorded
      // field that favours them can still keep them.
      var curSkills = cand.gear.map(function (g) { return g.skill; }), curKey = curSkills.slice().sort().join();
      var comps = pvCompositions(cand.gear.length).filter(function (c) {
        return c.filter(function (s) { return s === 'stun' || s === 'focus'; }).length <= 1;
      });
      if (!comps.some(function (c) { return c.slice().sort().join() === curKey; })) comps.push(curSkills);
      function withSkills(comp) { var c = pvCopy(cand); comp.forEach(function (sk, i) { c.gear[i].skill = sk; }); return c; }
      var quick = comps.map(function (comp) { return { comp: comp, key: comp.slice().sort().join(), m: pvScoreOf(withSkills(comp), live, 120).score }; });
      quick.sort(function (x, y) { return y.m - x.m; });
      var short = quick.slice(0, 5);
      if (!short.some(function (x) { return x.key === curKey; })) short.push(quick.filter(function (x) { return x.key === curKey; })[0] || quick[0]);
      // The finalists are close together, which is exactly when a small
      // sample misleads, and there are only six of them: settle it on
      // every contested opponent.
      short.forEach(function (x) { x.m = pvScoreOf(withSkills(x.comp), liveAll, 600).score; });
      short.sort(function (x, y) { return y.m - x.m; });
      // The winner, with the current skills kept when it is a tie, and each
      // piece keeping its own skill where the winning set still has it.
      var cur = short.filter(function (x) { return x.key === curKey; })[0];
      var pick = cur && cur.m >= short[0].m - 0.8 ? cur : short[0];   // inside the noise: keep what is there
      var left = pick.comp.slice(), out = new Array(cand.gear.length);
      cand.gear.forEach(function (g, i) { var j = left.indexOf(g.skill); if (j >= 0) { out[i] = g.skill; left.splice(j, 1); } });
      for (var i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = left.shift();
      cand.gear.forEach(function (g, i) { g.skill = out[i]; });

      var s = pvScoreOf(cand, pool), g = pvGap(plan.cur, s);
      plan.free = { build: cand, totals: pvTotals(cand), score: s.score, win: s.win, gain: g.gain, se: g.se, sure: g.gain > 2 * g.se };

      // What each next upgrade is worth, and what the materials and badges in hand buy right now.
      plan.base8 = pvScoreOf(pv, live, 800).score;
      plan.next = [];
      pv.gear.forEach(function (g, k) { ['level', 'tier'].forEach(function (kind) { plan.next = plan.next.concat(pvUpgradeRows(pv, live, plan.base8, k, kind)); }); });
      var sp = pvSpend(pv, keepBadges);
      plan.buy = { steps: sp.steps };
      if (sp.steps.length) {
        var b2 = pvCopy(pv); b2.gear = sp.gear;
        var s2 = pvScoreOf(b2, pool), g2 = pvGap(plan.cur, s2);
        plan.buy.score = s2.score; plan.buy.gain = g2.gain; plan.buy.se = g2.se; plan.buy.build = b2;
      }
      done(plan);
    } catch (e) { done(null, e); }
  }

  function pvReplay(rec, sims) {
    var A = arSide(rec.o), B = arSide(rec.e), w = 0, rounds = 0;
    for (var i = 0; i < sims; i++) {
      var r = rlDuel(A, B, rec.f === 1, 1000 + i * 7919);
      w += r.win === rec.w ? 1 : 0; rounds += r.rounds;
    }
    return { p: w / sims, rounds: rounds / sims };
  }

  function btRng(seed) {
    var a = seed | 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function wkSource() {
    var v = WK_VARS();
    return Object.keys(v).map(function (k) { return 'var ' + k + ' = ' + JSON.stringify(v[k]) + ';'; }).join('\n') + '\n' +
      WK_FNS().map(String).join('\n') + '\n(' + String(wkMain) + ')();';
  }

  var wkUrl = null;

  function wkRun(job, onMsg) {
    var w;
    try {
      if (!wkUrl) wkUrl = URL.createObjectURL(new Blob([wkSource()], { type: 'text/javascript' }));
      w = new Worker(wkUrl);
    } catch (e) { S.wkFail = String((e && e.message) || e); return null; }
    var rec = { kind: job.kind, at: Date.now(), end: 0, err: null };
    w.onmessage = function (e) {
      var m = e.data;
      if (m && (m.type === 'done' || m.type === 'error')) { w.terminate(); rec.end = Date.now(); rec.err = m.err || null; }
      try { onMsg(m); } catch (err) { setErr('background work: ' + ((err && err.message) || err)); }
    };
    w.onerror = function (e) { w.terminate(); rec.end = Date.now(); rec.err = (e && e.message) || 'the worker stopped'; try { onMsg({ type: 'error', err: (e && e.message) || 'the worker stopped' }); } catch (err) {} };
    w.postMessage(JSON.parse(JSON.stringify(job)));
    S.wkLast = rec;
    return w;
  }

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.root{--bg:#f4f6f8;--card:#fff;--tx:#1f2933;--mu:#6b7785;--bd:#e1e6eb;--ac:#2b7fa8;--tile:#eef3f7;--in:#fff;',
    '--good:#2f9e63;--warn:#b97b12;--bad:#cf4b45;--sh:0 8px 28px rgba(20,30,40,.22);',
    'font:13px/1.45 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;color:var(--tx)}',
    '.root.dark{--bg:#1a2129;--card:#222b35;--tx:#dbe4ec;--mu:#8898a8;--bd:#2f3b47;--ac:#63b6dc;--tile:#1f2831;--in:#1a2129;',
    '--good:#5ecb8f;--warn:#e0b04f;--bad:#e07a72;--sh:0 8px 28px rgba(0,0,0,.5)}',
    '.root *{font-variant-numeric:tabular-nums}',

    '#btn{position:fixed;top:10px;left:10px;display:flex;align-items:center;gap:7px;background:var(--card);color:var(--tx);',
    'font-weight:600;font-size:12px;padding:6px 12px;border:1px solid var(--bd);border-radius:999px;cursor:grab;user-select:none;box-shadow:var(--sh)}',
    '#btn:active{cursor:grabbing}',
    '#btn .dot{width:8px;height:8px;border-radius:50%;background:var(--mu)}',
    '#btn .lg{position:relative;display:flex}#btn .lg .dot{position:absolute;right:-3px;bottom:-3px;width:7px;height:7px;box-shadow:0 0 0 1.5px var(--card)}',
    '.dk #btn{position:static;box-shadow:none;cursor:pointer;padding:5px 12px 5px 9px}.dk #btn:active{cursor:pointer}',
    'svg.logo{width:16px;height:16px;flex:none;display:block}',
    '#btn.ok .dot{background:var(--good)}#btn.bad .dot{background:var(--bad)}#btn.busy .dot{background:var(--warn)}',

    '#panel{position:fixed;top:52px;left:10px;width:440px;max-height:86vh;display:flex;flex-direction:column;',
    'background:var(--bg);border:1px solid var(--bd);border-radius:12px;box-shadow:var(--sh);overflow:hidden}',
    '#bar{background:var(--card);padding:9px 12px;cursor:grab;display:flex;justify-content:space-between;align-items:center;',
    'user-select:none;border-bottom:1px solid var(--bd)}',
    '#bar b{font-size:13px;font-weight:700;letter-spacing:.2px}',
    '#bar .ttl{display:flex;align-items:center;gap:6px;min-width:0}',
    '#bar .beta{font-size:9px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--warn);',
    'border:1px solid var(--warn);border-radius:4px;padding:0 4px;line-height:14px;opacity:.85}',
    '#bar .ver{font-size:10px;color:var(--mu)}',
    '#bar .ctl{display:flex;gap:4px}',
    '#bar .g{cursor:pointer;color:var(--mu);padding:2px 8px;border-radius:6px;font-size:12px}',
    '#bar .g.on{color:var(--ac)}',
    '#bar .g:hover{background:var(--tile);color:var(--tx)}',
    '#quota{padding:5px 12px;font-size:11px;color:var(--mu);display:flex;justify-content:space-between;background:var(--card);border-bottom:1px solid var(--bd)}',
    '#quota .warn{color:var(--warn)}',
    '#tabs{display:flex;padding:0 6px;background:var(--card);border-bottom:1px solid var(--bd);overflow-x:auto;scrollbar-width:none}#tabs::-webkit-scrollbar{display:none}',
    '#tabs button{display:flex;align-items:center;gap:5px;background:none;border:0;border-bottom:2px solid transparent;color:var(--mu);padding:7px 7px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}',
    '#tabs button:hover{color:var(--tx)}',
    '#tabs button.on{color:var(--ac);border-bottom-color:var(--ac);font-weight:600}',
    '#tabs .ti img,#tabs .ti svg{width:20px;height:20px;display:block;opacity:.75}#tabs button.on .ti img,#tabs button.on .ti svg,#tabs button:hover .ti img{opacity:1}',
    '#tabs button.hasic .tn{display:none}#tabs button.hasic.on .tn{display:inline}#tabs .ti:empty{display:none}',
    '#body{overflow:auto;padding:12px}',
    '.bsub{color:var(--mu);font-size:11px;margin-bottom:6px}.foot{color:var(--mu);font-size:10px;margin-top:10px}',
    '.gobar{display:flex;gap:10px;align-items:center;margin:6px 0 8px}.gobar .mu{color:var(--mu);font-size:11px}',
    '.gobar button,button.mini{background:var(--ac);color:#0d1b24;border:0;border-radius:7px;padding:6px 10px;font:inherit;font-weight:600;cursor:pointer}',
    'button.mini{padding:2px 8px;font-size:11px;margin-left:8px}.gobar button[disabled],button.mini[disabled]{opacity:.5;cursor:default}',
    'table.t td.grp{color:var(--ac);font-weight:600}table.t td.r{text-align:right;white-space:nowrap}table.t td.b{font-weight:600}',
    'details{border-top:1px solid var(--bd);padding:4px 0;font-size:12px}summary{cursor:pointer}details .card{margin-top:6px}',
    '.det{padding:2px 0 2px 14px;color:var(--mu);font-size:11px}.det b{color:var(--tx);font-weight:600}',
    '.ship{display:grid;grid-template-columns:78px 1fr 78px;grid-template-rows:repeat(3,64px);gap:4px;margin:6px 0}',
    '.shippic{grid-row:1/4;grid-column:2;display:flex;align-items:center;justify-content:center}.shippic img{max-width:100%;max-height:190px;object-fit:contain}',
    '.item{display:flex;flex-direction:column;align-items:center;cursor:pointer;border-radius:8px;padding:2px}.item.on{background:var(--card)}',
    '.ibox{position:relative;width:38px;height:38px;border:1px solid #7b3fb8;background:#2a1b3d;border-radius:4px;display:flex;align-items:center;justify-content:center}',
    '.item.on .ibox{border-color:var(--ac)}.iname{font-size:11px}.ilv{font-size:10px;color:var(--ac)}',
    '.badge{position:absolute;top:-6px;right:-8px;background:var(--good);color:#0d1b24;font-size:9px;font-weight:700;border-radius:8px;padding:0 4px}',
    '.rows{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:6px 8px;margin-bottom:6px}',
    '.crow{display:flex;align-items:center;gap:4px;margin:3px 0 8px}.rname{width:78px;font-size:11px;color:var(--mu)}',
    '.cat{position:relative;width:32px;height:32px;border:2px solid;border-radius:5px;background:#1b1f2a;display:flex;align-items:center;justify-content:center}',
    '.cat.empty{border:1px dashed var(--bd);background:transparent}.cat.half{opacity:.6}',
    '.cat.sugg{border-style:dashed;margin-right:6px}.arrow{position:absolute;top:-7px;right:-5px;color:var(--good);font-size:10px}',
    '.hv{position:absolute;bottom:-4px;right:-3px;font-size:9px;color:var(--warn)}.hint{font-size:10px;margin-top:4px;color:var(--mu)}',
    '.lvb{position:absolute;bottom:-12px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--good);white-space:nowrap}',
    '#tip{position:fixed;z-index:10;pointer-events:none;background:#10151c;color:#dbe4ec;border:1px solid #2f3b47;border-radius:7px;padding:6px 8px;max-width:280px;display:none;box-shadow:0 8px 28px rgba(0,0,0,.5);font-size:12px}',
    '#tip div:first-child{font-weight:600}#tip div{white-space:nowrap}',

    '.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
    '.seg{display:flex;gap:6px;margin:2px 0 10px}',
    '.seg button{flex:1;padding:6px 0;border:1px solid var(--bd);background:var(--card);border-radius:8px;color:var(--mu);font:inherit;font-size:12px;cursor:pointer}',
    '.seg button.on{background:var(--tile,var(--card));color:var(--ac);border-color:var(--ac);font-weight:600}',
    '.tile{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:8px 10px;min-width:0}',
    '.tl{color:var(--mu);font-size:11px}',
    '.tv{font-size:18px;font-weight:650;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tv.est{color:var(--mu)}.tv.good{color:var(--good)}.tv.warn{color:var(--warn)}.tv.bad{color:var(--bad)}',
    '.ts{color:var(--mu);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.tiles.wr .ts{white-space:normal}',

    '.card{background:var(--card);border:1px solid var(--bd);border-radius:9px;margin-top:10px;overflow:hidden}',
    'table.t{width:100%;border-collapse:collapse;font-size:12px}',
    'table.t th{color:var(--mu);font-weight:500;font-size:11px;text-align:right;padding:6px 8px;border-bottom:1px solid var(--bd);background:var(--tile)}',
    'table.t td{text-align:right;padding:5px 8px}',
    'table.t th:first-child,table.t td:first-child{text-align:left}',
    'table.t tr+tr td{border-top:1px solid var(--bd)}',
    'table.t td.good{color:var(--good)}table.t td.warn{color:var(--warn)}table.t td.bad{color:var(--bad)}table.t td.mu{color:var(--mu)}',
    'table.t tr.hl td{background:var(--tile);font-weight:600}',

    '.kvs{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;font-size:12px}',
    '.kv i{font-style:normal;color:var(--mu);margin-right:5px}',
    '.line{font-size:11px;margin-top:8px;color:var(--mu)}',
    '.line.warn{color:var(--warn)}.line.bad{color:var(--bad)}.line.good{color:var(--good)}',
    '.empty{color:var(--mu);padding:18px 4px;text-align:center}',

    'h4{margin:16px 0 6px;font-size:11px;font-weight:600;color:var(--mu);letter-spacing:.3px}',
    'button.mg{display:flex;width:100%;margin:12px 0 6px;padding:0;border:0;background:none;color:var(--mu);font:inherit;font-size:11px;font-weight:600;letter-spacing:.3px;cursor:pointer;text-align:left}button.mg span{margin-left:auto;font-weight:400}button.mg:hover{color:var(--ac)}',
    'h4:first-child{margin-top:0}',
    '.sh{display:flex;align-items:flex-end;gap:8px;margin:16px 0 6px}.sh h4{margin:0;flex:1;padding-bottom:5px}',
    '.sh label.sp{display:flex;align-items:center;gap:6px}.sh label.sp input{width:86px;margin:0;text-align:right}',
    '.sh button.lk{background:none;border:0;color:var(--ac);font:inherit;font-size:11px;cursor:pointer;padding:0 0 5px}',
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    'label{display:block;color:var(--mu);font-size:11px}',
    'label.c{display:flex;align-items:center;gap:6px;color:var(--tx);font-size:12px;padding:2px 0}',
    'input,select{width:100%;margin-top:2px;background:var(--in);color:var(--tx);border:1px solid var(--bd);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px}',
    'input:focus,select:focus{outline:2px solid var(--ac);outline-offset:-1px}',
    'input[type=checkbox]{width:auto;margin:0}',
    '.row{display:flex;gap:8px;margin-top:12px}',
    'button.act{flex:1;background:var(--card);color:var(--tx);border:1px solid var(--bd);border-radius:7px;padding:7px 10px;cursor:pointer;font:inherit;font-size:12px}',
    'button.act:hover{border-color:var(--ac);color:var(--ac)}button.act[disabled]{opacity:.45;cursor:default}',
    'pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:9px;margin:8px 0 0;',
    'font:11px/1.45 Consolas,"SF Mono",Menlo,monospace;color:var(--tx)}'
  ].join('');

  function draggable(el, handle, key, onClick, locked) {
    var down = false, moved = false, sx = 0, sy = 0, sl = 0, sT = 0;
    var saved = store.get(key, null);
    if (saved) { el.style.left = saved.l + 'px'; el.style.top = saved.t + 'px'; }
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      down = true; moved = false; sx = e.clientX; sy = e.clientY;
      var r = el.getBoundingClientRect(); sl = r.left; sT = r.top;
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', function (e) {
      if (!down) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (locked && locked()) return;
      moved = true;
      el.style.left = clamp(0, window.innerWidth - 60, sl + dx) + 'px';
      el.style.top = clamp(0, window.innerHeight - 24, sT + dy) + 'px';
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (!down) return;
      down = false;
      if (moved) { var r = el.getBoundingClientRect(); store.set(key, { l: Math.round(r.left), t: Math.round(r.top) }); }
      else if (onClick) onClick(e);
    }, true);
  }

  function tile(label, value, sub, cls) {
    return '<div class="tile"><div class="tl">' + esc(label) + '</div><div class="tv' + (cls ? ' ' + cls : '') + '">' + esc(value) + '</div>' +
      (sub ? '<div class="ts">' + esc(sub) + '</div>' : '') + '</div>';
  }

  function tbl(head, rows, hlRow) {
    var h = '<div class="card"><table class="t">' + (head ? '<thead><tr>' +
      head.map(function (x) { return '<th>' + esc(x) + '</th>'; }).join('') + '</tr></thead>' : '') + '<tbody>';
    rows.forEach(function (r, i) {
      h += '<tr' + (hlRow === i ? ' class="hl"' : '') + '>' + r.map(function (c) {
        if (c === null || c === undefined) return '<td class="mu">--</td>';
        if (typeof c === 'object') return '<td class="' + (c.c || '') + '">' + esc(c.t) + '</td>';
        return '<td>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  function kvs(pairs) {
    return '<div class="kvs">' + pairs.filter(function (p) { return p; }).map(function (p) {
      return '<span class="kv"><i>' + esc(p[0]) + '</i>' + esc(p[1]) + '</span>';
    }).join('') + '</div>';
  }

  function line(text, cls) { return '<div class="line' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</div>'; }

  function sect(t) { return '<h4>' + esc(t) + '</h4>'; }

  function pct(x, dp) { return x === null || x === undefined || isNaN(x) ? '--' : (x * 100).toFixed(dp === undefined ? 1 : dp) + '%'; }

  var bsub = 'cur';

  var bshow = false;

  var pvBusy = null;

  var pvFailed = null;

  var pvMemo = { key: null, plan: null };

  var pvCheck = {};

  var pvCheckBusy = false;

  function grp(x) { return Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function cap(x) { x = String(x || ''); return x.charAt(0).toUpperCase() + x.slice(1); }

  function pts1(x) { return (x >= 0 ? '+' : '') + x.toFixed(1); }

  function whenTxt(ms) {
    var d = new Date(ms), n = new Date(), t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var day = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    return day === 0 ? 'Today ' + t : (day === 1 ? 'Yesterday ' + t : d.getDate() + '/' + (d.getMonth() + 1) + ' ' + t);
  }

  var REC_WATCH_MS = 1000;

  var REC_TRIES = 5;

  var recSeen = null;

  var recTries = { fp: null, n: 0 };

  var recRoot = null;

  var recFindAt = 0;

  function recState() {
    if (recRoot && !recRoot.UserStore) recRoot = null;
    if (!recRoot && Date.now() - recFindAt >= 3000) {
      recFindAt = Date.now();
      try { var p = findPinia(); recRoot = (p && p.state && p.state.value) || null; } catch (e) {}
    }
    return recRoot;
  }

  function pvRequest(pv) {
    var recs = S.battles, keep = S.inputs.keepBadges || 0;
    // With no duels on record the plan still runs, against the meta field.
    var key = pvPlanKey(pv, keep, recs);
    if (pvMemo.key === key) return pvMemo.plan;
    if (pvBusy !== key && pvFailed !== key) {
      pvBusy = key;
      // In the background worker (12i): same code, same seeds, same plan.
      var w = wkRun({ kind: 'pvp', pv: pv, recs: recs, keep: keep }, function (m) {
        if (m.type !== 'plan' && m.type !== 'error') return;
        if (pvBusy === key) pvBusy = null;
        if (m.type === 'error' || m.err || !m.plan) { pvFailed = key; setErr('The battle plan failed: ' + (m.err || 'no plan')); }
        else pvMemo = { key: key, plan: m.plan };
        if (panel.style.display !== 'none' && tab === 'battle') render();
      });
      if (!w) { pvBusy = null; pvFailed = key; setErr('The battle plan needs a background worker, and this browser refused one.'); }
    }
    return null;
  }

  function buildTables(b, tot, vs, vsTot) {
    var g = pvGearBase(b), g0 = vs ? pvGearBase(vs) : null;
    function c(x, y, f) { return vs && x !== y ? { t: f ? f(x) : String(x), c: 'good' } : (f ? f(x) : String(x)); }
    var h = tbl(['Stat', 'Points', 'Gear + pet', 'Total'], PVP_STATS.map(function (s) {
      return [cap(s), c(b.pts[s], vs && vs.pts[s], grp), c(g[s], vs && g0[s], grp), c(tot[s], vs && vsTot[s], grp)];
    }));
    h += tbl(['Piece', 'Level', 'Tier', 'Stat', 'Skill'], b.gear.map(function (x, i) {
      var o = vs && vs.gear[i];
      return [cap(x.name), c(x.L, o && o.L), c(x.T, o && o.T), c(cap(x.stat), o && cap(o.stat)), c(cap(x.skill), o && cap(o.skill))];
    }));
    return h;
  }

  function hitLines(t, ref, t1) {
    var a = t.precision / (t.precision + ref.evasion), b = ref.precision / (ref.precision + t.evasion);
    if (!t1) return kvs([['You hit', pct(a, 0)], ['They hit', pct(b, 0)]]);
    var a1 = t1.precision / (t1.precision + ref.evasion), b1 = ref.precision / (ref.precision + t1.evasion);
    return kvs([['You hit', pct(a, 0) + ' \u2192 ' + pct(a1, 0)], ['They hit', pct(b, 0) + ' \u2192 ' + pct(b1, 0)]]);
  }

  function subTabs() {
    return '<div class="seg">' + [['cur', 'Current'], ['best', 'Best'], ['up', 'Upgrades'], ['fights', 'Duels']].map(function (x) {
      return '<button data-sub="' + x[0] + '"' + (bsub === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>';
    }).join('') + '</div>';
  }

  function waitLine() {
    return S.battles.length ? line(S.lastErr && pvFailed ? S.lastErr : 'Working out the numbers...') : '';
  }

  function renderCur(pv, plan) {
    var t0 = pvTotals(pv), h = '';
    h += '<div class="tiles">' + tile('Damage', grp(t0.damage), 'per clone hit') + tile('Health', grp(t0.hp), 'per clone') +
      tile('Win rate', plan ? pvPct(plan.cur.score) + '%' : '--',
        plan ? (plan.synthetic ? 'vs the meta field' : '\u00b1' + seTxt(plan.cur.se) + ', ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's')) : 'working') + '</div>';
    h += sect('Stat points') + buildTables(pv, t0);
    if (plan) h += hitLines(t0, plan.ref);
    else h += waitLine();
    h += line(plan && plan.synthetic
      ? 'Read from your game. The win rate is how often this build wins a simulated duel against the meta field at your own total stat (see Best), half attacking and half defending. It switches to your real opponents once ' + PV_FLOOR + ' duels are on record.'
      : 'Read from your game. The win rate is how often this build wins a simulated duel against the arena opponents on record, half of them attacking and half defending.');
    if (plan) h += confLine(plan);
    return h;
  }

  function metaPoints(pv, frac) {
    var base = pvGearBase(pv), pool = Math.max(0, Math.round(pv.pool)), total = pool;
    PVP_STATS.forEach(function (s) { total += base[s]; });
    var pts = {}, open = PVP_STATS.slice(), left = pool;
    for (var guard = 0; guard < 5 && open.length; guard++) {
      var share = 0; open.forEach(function (s) { share += frac[PVP_STATS.indexOf(s)]; });
      var baseOpen = 0; open.forEach(function (s) { baseOpen += base[s]; });
      var over = [];
      open.forEach(function (s) {
        var want = (left + baseOpen) * frac[PVP_STATS.indexOf(s)] / share - base[s];
        if (want < 0) { pts[s] = 0; over.push(s); } else pts[s] = want;
      });
      if (!over.length) break;
      open = open.filter(function (s) { return over.indexOf(s) < 0; });
    }
    // whole points that add up to the pool
    var used = 0; PVP_STATS.forEach(function (s) { pts[s] = Math.floor(pts[s] || 0); used += pts[s]; });
    while (used < pool) { var best = null, bd = -Infinity; PVP_STATS.forEach(function (s, i) { var d = frac[i] * total - base[s] - pts[s]; if (d > bd) { bd = d; best = s; } }); pts[best]++; used++; }
    return pts;
  }

  function metaGear(pv, frac) {
    var n = pv.gear.length, total = Math.pow(PVP_STATS.length, n), best = null;
    // "Nearest" is judged by the planner's own strength formula against a
    // meta opponent at the same total (pvTerm), not by distance in the
    // shares: too little precision or evasion hurts more than too much, and
    // the formula knows that (30/20/20/30 beats 40/10/10/40, as the
    // simulation also says).
    var budget = Math.max(0, Math.round(pv.pool)), b0 = pvGearBase(pv);
    PVP_STATS.forEach(function (s) { budget += b0[s]; });
    var ref = { precision: frac[1] * budget, evasion: frac[2] * budget };
    for (var a = 0; a < total; a++) {
      var c = pvCopy(pv), x = a, same = true;
      for (var i = 0; i < n; i++) { c.gear[i].stat = PVP_STATS[x % PVP_STATS.length]; if (c.gear[i].stat !== pv.gear[i].stat) same = false; x = Math.floor(x / PVP_STATS.length); }
      var pts = metaPoints(c, frac), base = pvGearBase(c), t = {}, score = 0, sum = 0, off = 0;
      PVP_STATS.forEach(function (s) { t[s] = base[s] + pts[s]; score += pvTerm(s, t[s], ref); sum += t[s]; });
      PVP_STATS.forEach(function (s, i) { off = Math.max(off, Math.abs((sum ? t[s] / sum : 0) - frac[i])); });
      // An assignment that lands on the split (every share within a point)
      // is as good as any other that does, so the pieces stay as they are
      // when they already allow it; the formula only decides when none does.
      var hit = off <= 0.01, cand = { gear: c.gear, pts: pts, base: base, t: t, score: score, same: same, hit: hit };
      if (!best) { best = cand; continue; }
      if (hit && !best.hit) best = cand;
      else if (hit === best.hit) {
        if (hit) { if (same) best = cand; }   // any assignment that lands is fine: keep the pieces as they are when they do
        else if (score > best.score + 1e-9 || (same && score >= best.score - 1e-9)) best = cand;
      }
    }
    return best;
  }

  function metaTable(pv, t0) {
    var budget = t0.power + t0.precision + t0.evasion + t0.hull;
    var meta = PV_META[0].f, naive = PV_NAIVE_BEST, gm = metaGear(pv, meta), gn = metaGear(pv, naive), pm = gm.pts, pn = gn.pts;
    var rows = PVP_STATS.map(function (s, i) {
      var now = t0[s], share = budget ? now / budget : 0;
      return [cap(s), grp(pv.pts[s] || 0) + ' pts, ' + grp(now) + ' (' + Math.round(share * 100) + '%)',
        { t: grp(pm[s]) + ' pts', c: Math.abs(pm[s] - (pv.pts[s] || 0)) > 1 ? 'good' : '' }, grp(gm.t[s]) + ' (' + Math.round(gm.t[s] / budget * 100) + '%)',
        { t: grp(pn[s]) + ' pts', c: Math.abs(pn[s] - (pv.pts[s] || 0)) > 1 ? 'good' : '' }];
    });
    function gearTxt(g) { return g.map(function (x) { return cap(x.name) + ' ' + cap(x.stat); }).join(', '); }
    rows.push(['Gear stats', gearTxt(pv.gear), { t: gm.same ? 'as now' : gearTxt(gm.gear), c: gm.same ? '' : 'good' }, '', { t: gn.same ? 'as now' : gearTxt(gn.gear), c: gn.same ? '' : 'good' }]);
    rows.push(['Skills', pv.gear.map(function (g) { return cap(g.skill); }).join(', '), { t: 'Block x4, or DoT + Block x3', c: 'b' }, '', { t: 'Block x4', c: 'b' }]);
    var h = sect('The meta, at your total stat') + tbl(['', 'You now', 'Meta: your points', 'Meta total', 'Even-split ladder: points'], rows);
    h += line('"Your points" is where to put your ' + grp(pv.pool) + ' PvP stat points, with the gear stats in the row below, to land on that split; green differs from now. Which stat a piece carries is worth nothing in itself: it only matters that the points can still reach the split. The row picks the assignment that lands nearest; a stat the gear already pushes past its share gets no points.', 'mu');
    h += line('From self-play on this simulator at equal total stat: the split no build beats on average. Attacker and defender want the same split; the defender can afford a DoT piece or two. Stun and Focus lose at equal budget. Against a young ladder of even-split players, more precision pays.', 'mu');
    h += line('Total stat decides most duels before the split does: 15% less than your opponent is 3 wins in 100 whatever the build. Gear levels and tiers beat any re-split.', 'mu');
    return h;
  }

  function seTxt(se) { return se >= 10 ? String(Math.round(se)) : String(Math.round(se * 10) / 10); }

  function confLine(plan) {
    var n = plan.pool, se = plan.cur ? plan.cur.se : 50;
    if (plan.synthetic) {
      return line('Meta field: ' + (n ? n + ' duel' + (n === 1 ? '' : 's') : 'no duel') + ' on record, under the ' + PV_FLOOR +
        ' needed, so the numbers are against the simulated equal-budget meta instead of your real opponents. Fight in the arena, or open duels in Battlefield > Battle Log > Arena, and they take over.', 'warn');
    }
    var word = se > 12 ? 'Rough' : (se > 7 ? 'Fair' : (se > 4 ? 'Good' : 'Strong'));
    var txt = word + ': ' + n + ' duel' + (n === 1 ? '' : 's') + ' on record, win rate good to about ' +
      String.fromCharCode(177) + seTxt(se) + ' points.';
    if (plan.need > 0) txt += ' About ' + plan.need + ' more would bring it to ' + String.fromCharCode(177) + '5.';
    return line(txt, n < PV_FLOOR ? 'warn' : '');
  }

  function renderBest(pv, plan) {
    if (!plan) return waitLine() || line('Working out the numbers...');
    var t0 = pvTotals(pv);
    if (plan.stop) {
      return '<div class="tiles">' + tile('Duels', String(plan.pool), 'on record') +
        tile('Win rate', pvPct(plan.cur.score) + '%', '\u00b1' + seTxt(plan.cur.se)) +
        tile('Verdict', 'Nothing to tune', plan.decided + ' already settled', 'good') + '</div>' +
        line('Every opponent on record is one you always beat or always lose to, so no change of build would alter a single result. This will have something to say once you meet someone closer to your own strength.') +
        confLine(plan) + metaTable(pv, t0);
    }
    var f = plan.free, h = '';
    // The gain has to beat its own error bar, not a number I picked.
    var bar = Math.max(2 * f.se, S.inputs.bestGap || 0), worth = f.gain > bar;
    var pm = String.fromCharCode(177);
    if (!worth && !bshow) {
      h += '<div class="tiles">' + tile('Win rate now', pvPct(plan.cur.score) + '%', pm + seTxt(plan.cur.se)) +
        tile('Best found', pvPct(f.score) + '%', pts1(f.gain) + ' ' + pm + seTxt(f.se)) +
        tile('Verdict', 'In range', 'keep your build', 'good') + '</div>';
      h += line('The best change found is worth ' + pts1(f.gain) + ' points of win rate, give or take ' + seTxt(f.se) +
        '. That is inside the noise, so it is not a real improvement and your build stays as it is.');
      h += confLine(plan);
      h += '<div class="row"><button class="act" id="b_showbest">Show the best found anyway</button></div>';
      return h + metaTable(pv, t0);
    }
    h += '<div class="tiles">' + tile('Damage', grp(f.totals.damage), 'now ' + grp(t0.damage)) + tile('Health', grp(f.totals.hp), 'now ' + grp(t0.hp)) +
      tile('Win rate', pvPct(f.score) + '%', pts1(f.gain) + ' ' + pm + seTxt(f.se), worth ? 'good' : '') + '</div>';
    h += sect('Suggested build') + buildTables(f.build, f.totals, pv, t0);
    h += hitLines(t0, plan.ref, f.totals);
    if (worth) h += line('Free changes only, nothing to buy. Green is different from your current build. Worth ' + pts1(f.gain) +
      ' points of win rate, give or take ' + seTxt(f.se) + ', measured against the same opponents with the same rolls.');
    else h += line('Worth ' + pts1(f.gain) + ' points give or take ' + seTxt(f.se) + ': inside the noise.', 'warn');
    h += confLine(plan);
    return h + metaTable(pv, t0);
  }

  function renderUp(pv, plan) {
    var h = '', rows;
    if (plan && !plan.stop) rows = plan.next;
    else {
      rows = []; pv.gear.forEach(function (g, i) { rows = rows.concat(pvUpgradeRows(pv, null, 0, i)); });
      if (!plan && S.battles.length) h += waitLine();
      if (plan && plan.thin) h += line('Costs only: with ' + plan.pool + ' duel' + (plan.pool === 1 ? '' : 's') +
        ' on record out of ' + plan.floor + ', there is not enough to say what an upgrade is worth.', 'warn');
      else if (plan) h += line('Costs only: every opponent on record is already settled either way, so no upgrade would change a result.', 'warn');
    }
    if (plan && !plan.stop && plan.buy.steps.length) {
      h += '<div class="tiles">' + tile('Win rate now', pvPct(plan.cur.score) + '%', '') + tile('After buying', pvPct(plan.buy.score) + '%', pts1(plan.buy.gain) + ' points', 'good') + tile('Steps', String(plan.buy.steps.length), 'upgrades') + '</div>';
      h += sect('Affordable now') + tbl(['Piece', 'Upgrade', 'Cost'], plan.buy.steps.map(function (x) {
        return [cap(x.name), cap(x.kind) + ' ' + x.from + ' \u2192 ' + x.to, grp(x.cost) + ' ' + x.res];
      }));
    }
    rows = rows.slice().sort(function (a, b) { return (b.gain === null ? 0 : b.gain) - (a.gain === null ? 0 : a.gain); }).slice(0, 6);
    h += sect('Next upgrades') + tbl(['Upgrade', 'Cost', 'You have', 'Gain'], rows.map(function (r) {
      return [cap(r.name) + ' ' + r.kind + ' ' + (r.from + 1), grp(r.cost) + ' ' + r.res, { t: grp(r.have), c: r.have >= r.cost ? 'good' : '' }, r.gain === null ? null : pts1(r.gain)];
    }));
    h += line('Gain is the change in win rate, in points, from that one upgrade on its own.');
    if (plan && !plan.stop) h += confLine(plan);
    return h;
  }

  var PV_CHECK_SIMS = 40;

  var PV_CHECK_MAX = 40;

  function pvCheckRun() {
    if (pvCheckBusy) return;
    // Only the recent ones: the check is a sanity reading on the model, not a
    // census, and replaying 200 duels trickles work for nine seconds.
    var todo = S.battles.slice(-PV_CHECK_MAX).filter(function (r) { return !pvCheck[arKey(r)]; });
    if (!todo.length) return;
    pvCheckBusy = true;
    // All of them in one background job (12i), each result as it comes.
    var w = wkRun({ kind: 'replay', recs: todo, sims: PV_CHECK_SIMS }, function (m) {
      if (m.type === 'replay') pvCheck[arKey(todo[m.i])] = m.res || { p: null, rounds: null };
      if (m.type === 'done' || m.type === 'error') {
        todo.forEach(function (r) { if (!pvCheck[arKey(r)]) pvCheck[arKey(r)] = { p: null, rounds: null }; });
        pvCheckBusy = false;
      }
      if (panel.style.display !== 'none' && tab === 'battle' && bsub === 'fights') render();
    });
    if (!w) { todo.forEach(function (r) { pvCheck[arKey(r)] = { p: null, rounds: null }; }); pvCheckBusy = false; }
  }

  function renderFights() {
    var recs = S.battles, h = '', n = recs.length;
    var wins = recs.filter(function (r) { return r.w; }).length, stale = recs.filter(function (r) { return r.a; }).length;
    var plan = pvMemo.plan;
    h += '<div class="tiles">' +
      tile('Recorded', n + ' / ' + AR_MAX, n < PV_FLOOR ? (PV_FLOOR - n) + ' more to use real opponents' :(n ? 'last ' + whenTxt(recs[n - 1].t).toLowerCase() : 'none yet'),
        n < PV_FLOOR ? 'warn' : '') +
      tile('Record', wins + (wins === 1 ? ' win' : ' wins'), (n - wins) + (n - wins === 1 ? ' loss' : ' losses')) +
      tile('Useful', plan && plan.contested !== undefined ? String(plan.contested) : '--',
        plan && plan.contested !== undefined ? plan.decided + ' already settled' : 'not worked out yet',
        plan && plan.contested >= PV_CONTESTED ? 'good' : '') + '</div>';
    if (plan && plan.contested !== undefined)
      h += line('Useful counts the opponents a change of build could actually swing. The settled ones are those this build always beats, or never beats: they look the same whatever you do, so the tuning ignores them.');
    if (n) {
      h += tbl(['When', 'Result', 'Their clones', 'Their damage', 'Rounds'], recs.slice(-6).reverse().map(function (r) {
        return [whenTxt(r.t) + (r.a ? ' ~' : ''), { t: r.w ? 'Won' : 'Lost', c: r.w ? 'good' : 'bad' },
          String(r.e.n), fmt(r.e.d, 0), String(r.r)];
      }));
      if (stale) h += line('~ marks a duel fought on a different build of yours. Its opponent is still recorded exactly, but the precision and evasion read off it are less reliable.');
      var ok = recs.slice(-PV_CHECK_MAX).map(function (r) { return pvCheck[arKey(r)]; }).filter(function (x) { return x && x.p !== null; });
      if (ok.length) {
        var avgP = ok.reduce(function (a, x) { return a + x.p; }, 0) / ok.length, sim = ok.reduce(function (a, x) { return a + x.rounds; }, 0) / ok.length;
        var real = recs.reduce(function (a, r) { return a + r.r; }, 0) / n;
        h += kvs([['Model check', 'real winner in ' + pct(avgP, 0) + ' of replays'], ['Rounds', Math.round(real) + ' real / ' + Math.round(sim) + ' simulated']]);
        h += line('Each duel is replayed with the two fighters as recorded. Opponent precision, evasion, skills and crit are estimates; clones, health and damage are read from the log.');
      }
    } else {
      h += line('Recording runs in the background, whatever tab is open. Fight in the arena, or open any duel in Battlefield > Battle Log > Arena, and it is filed away here.');
    }
    var kb = n ? Math.max(1, Math.round(JSON.stringify(recs).length / 1024)) : 0;
    h += kvs([['Stored', kb + ' KB'], ['Names', 'not saved']]);
    h += '<div class="row"><label class="c"><input type="checkbox" id="f_rec"' + (S.inputs.recBattles === false ? '' : ' checked') + '>Record duels</label></div>';
    if (n) h += '<div class="row" style="margin-top:0"><button class="act" id="b_clearrec">Clear recorded duels</button></div>';
    if (n) pvCheckRun();
    return h;
  }

  /* ============================================================
     BATTLE ARCHIVE (1.1.0)

     Keeps what the game sends this page about PvP, as the player browses:
     squadron battles with their full logs and both groups' member data
     (Battle Log > Squadron), the arena duel list and every duel opened with
     View battle, the squadron's groups (Squadron Groups) and the map. It
     only listens to answers the game itself asked for and received: it sends
     nothing, clicks nothing and pages through nothing (the game's rules
     allow scripts for information only). Kept whole, in this browser's
     IndexedDB, for the squadron simulator and group builder that come next.
     ============================================================ */

  var ARC_RE = /\/api\/(squadrons\/(battlelog|groups)|battlefield\/(arenaduels|map))(\?|$)/;

  // Runs in the game's own page, before its app starts: wraps the browser's
  // XMLHttpRequest and fetch so that, when the game's request for one of the
  // four lists comes back, a copy of the answer is handed to this script.
  function arcHook() {
    if (window.__sopvpHook) return;
    window.__sopvpHook = 1;
    var RE = /\/api\/(squadrons\/(battlelog|groups)|battlefield\/(arenaduels|map))(\?|$)/;
    function abs(u) { try { return new URL(String((u && u.href) || u), location.href).href; } catch (e) { return String(u); } }
    function hand(url, text) { try { window.postMessage({ __sopvp: 1, url: String(url), text: text }, location.origin); } catch (e) {} }
    var XP = XMLHttpRequest.prototype, oOpen = XP.open, oSend = XP.send;
    XP.open = function (m, u) { try { this.__sopvpU = abs(u); } catch (e) {} return oOpen.apply(this, arguments); };
    XP.send = function () {
      var x = this;
      try {
        if (RE.test(x.__sopvpU || '')) x.addEventListener('load', function () {
          try {
            if (x.status < 200 || x.status >= 300) return;
            var t = (x.responseType === '' || x.responseType === 'text') ? x.responseText : (x.responseType === 'json' ? JSON.stringify(x.response) : null);
            if (t) hand(x.responseURL || x.__sopvpU, t);
          } catch (e) {}
        });
      } catch (e) {}
      return oSend.apply(this, arguments);
    };
    var oFetch = window.fetch;
    if (typeof oFetch === 'function') window.fetch = function (input) {
      var p = oFetch.apply(this, arguments);
      try {
        var u = abs(typeof input === 'string' ? input : (input && input.url));
        if (RE.test(u || '')) p.then(function (r) { if (r.ok) r.clone().text().then(function (t) { hand(r.url || u, t); }, function () {}); }, function () {});
      } catch (e) {}
      return p;
    };
  }
  try {
    var hookEl = document.createElement('script');
    hookEl.textContent = '(' + String(arcHook) + ')();';
    (document.head || document.documentElement).appendChild(hookEl);
    hookEl.remove();
  } catch (e) { setErr('the battle archive could not start: ' + ((e && e.message) || e)); }

  var REALM = /^steam\./i.test(location.hostname) ? 'steam' : 'web';
  var ARC = { db: null, n: { squad: 0, duel: 0, duelList: 0, roster: 0, map: 0 }, last: 0, bytes: 0, err: null };
  var ARC_STORES = ['squad', 'duel', 'duelList', 'roster', 'map'];

  function arcOpen() {
    if (ARC.db) return Promise.resolve(ARC.db);
    return new Promise(function (ok, no) {
      var rq;
      try { rq = indexedDB.open('sopvp-archive', 1); } catch (e) { no(e); return; }
      rq.onupgradeneeded = function () { var d = rq.result; ARC_STORES.forEach(function (s) { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); }); };
      rq.onsuccess = function () { ARC.db = rq.result; ok(ARC.db); };
      rq.onerror = function () { no(rq.error); };
    });
  }
  function arcTx(store, mode, fn) {
    return arcOpen().then(function (d) {
      return new Promise(function (ok, no) {
        var tx = d.transaction(store, mode), os = tx.objectStore(store), out = fn(os);
        tx.oncomplete = function () { ok(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { no(tx.error); };
        tx.onabort = function () { no(tx.error); };
      });
    });
  }
  // Adds what is not stored yet; returns how many were new.
  function arcPutNew(store, items) {
    if (!items.length) return Promise.resolve(0);
    return arcOpen().then(function (d) {
      return new Promise(function (ok, no) {
        var tx = d.transaction(store, 'readwrite'), os = tx.objectStore(store), added = 0;
        items.forEach(function (it) {
          var g = os.getKey(it.k);
          g.onsuccess = function () { if (g.result === undefined) { os.put(it.v, it.k); added++; } };
        });
        tx.oncomplete = function () { ok(added); };
        tx.onerror = function () { no(tx.error); };
      });
    });
  }
  function arcCount() {
    return Promise.all(ARC_STORES.map(function (s) { return arcTx(s, 'readonly', function (os) { return os.count(); }); })).then(function (c) {
      ARC_STORES.forEach(function (s, i) { ARC.n[s] = c[i]; });
      try { if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().then(function (e) { ARC.bytes = e.usage || 0; }); } catch (e) {}
    });
  }
  // A snapshot (roster, map) is kept only when it differs from the last one.
  var arcLastSnap = {};
  function arcSnap(store, text, keep) {
    if (arcLastSnap[store] === text) return Promise.resolve(0);
    arcLastSnap[store] = text;
    var k = REALM + '|' + Date.now();
    return arcPutNew(store, [{ k: k, v: { t: Date.now(), realm: REALM, body: text } }]).then(function (n) {
      if (!keep) return n;
      return arcTx(store, 'readwrite', function (os) {
        var c = os.getAllKeys();
        c.onsuccess = function () { var ks = c.result.filter(function (x) { return String(x).indexOf(REALM + '|') === 0; }).sort(); ks.slice(0, Math.max(0, ks.length - keep)).forEach(function (x) { os.delete(x); }); };
      }).then(function () { return n; });
    });
  }

  function arcTake(url, text) {
    var body;
    try { body = JSON.parse(text); } catch (e) { return; }
    var job = null;
    if (/squadrons\/battlelog/.test(url)) {
      var bs = (body && Array.isArray(body.battles)) ? body.battles : [];
      job = arcPutNew('squad', bs.filter(function (b) { return b && b._id && Array.isArray(b.logs); }).map(function (b) {
        return { k: REALM + '|' + b._id, v: { realm: REALM, saved: Date.now(), battle: b } };
      }));
    } else if (/battlefield\/arenaduels/.test(url)) {
      var rs = (body && Array.isArray(body.results)) ? body.results : [];
      job = arcPutNew('duelList', rs.filter(function (r) { return r && r._id; }).map(function (r) { return { k: REALM + '|' + r._id, v: { realm: REALM, saved: Date.now(), row: r } }; }));
    } else if (/squadrons\/groups/.test(url)) job = arcSnap('roster', text, 0);
    else if (/battlefield\/map/.test(url)) job = arcSnap('map', text, 100);
    if (!job) return;
    job.then(function () { ARC.last = Date.now(); ARC.err = null; return arcCount(); })
      .then(function () { if (panel.style.display !== 'none' && view === 'set') render(); }, function (e) { ARC.err = String((e && e.message) || e); });
  }

  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__sopvp !== 1 || typeof d.url !== 'string' || typeof d.text !== 'string' || !ARC_RE.test(d.url)) return;
    if (S.inputs.archive === false) return;
    arcTake(d.url, d.text);
  });

  // An arena duel's log only reaches the page when it is opened (View
  // battle): the one in the game's arena store is kept, whole, once.
  var arcDuelSeen = null;
  function arcDuelTick() {
    if (S.inputs.archive === false) return;
    var st = recState(), A = st && st.PvPArenaStore, d;
    try { d = A && A.currentDuel; } catch (e) { return; }
    if (!d || !d._id || !Array.isArray(d.logs) || !d.logs.length || arcDuelSeen === d._id) return;
    arcDuelSeen = d._id;
    var copy;
    try { copy = JSON.parse(JSON.stringify(d)); } catch (e) { return; }
    arcPutNew('duel', [{ k: REALM + '|' + d._id, v: { realm: REALM, saved: Date.now(), duel: copy } }])
      .then(function (n) { if (n) { ARC.last = Date.now(); return arcCount(); } }, function (e) { ARC.err = String((e && e.message) || e); });
  }

  function arcDownload() {
    return Promise.all(ARC_STORES.map(function (s) { return arcTx(s, 'readonly', function (os) { return os.getAll(); }); })).then(function (all) {
      var o = { app: 'PvP Meta battle archive', version: scriptVersion(), exported: new Date().toISOString() };
      ARC_STORES.forEach(function (s, i) { o[s] = all[i]; });
      var url = URL.createObjectURL(new Blob([JSON.stringify(o)], { type: 'application/json' })), a = document.createElement('a');
      a.href = url; a.download = 'pvp-archive-' + REALM + '-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    });
  }
  function arcClear() {
    return Promise.all(ARC_STORES.map(function (s) { return arcTx(s, 'readwrite', function (os) { os.clear(); }); })).then(function () { arcLastSnap = {}; arcDuelSeen = null; return arcCount(); });
  }

  function mbTxt(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }
  function renderArchive() {
    var h = sect('Battle archive');
    h += '<div class="tiles">' + tile('Squadron battles', grp(ARC.n.squad), 'full logs') + tile('Arena duels', grp(ARC.n.duel), grp(ARC.n.duelList) + ' in the list') +
      tile('Roster', ARC.n.roster ? String(ARC.n.roster) : '--', ARC.n.roster ? 'snapshots' : 'open Squadron Groups') + '</div>';
    h += kvs([['Map snapshots', String(ARC.n.map)], ['Stored in this browser', ARC.bytes ? mbTxt(ARC.bytes) : '--'], ['Last saved', ARC.last ? whenTxt(ARC.last) : 'not this session']]);
    if (ARC.err) h += line('Archive error: ' + ARC.err, 'bad');
    h += line('Kept as you browse: Battlefield › Battle Log (squadron battles come with their full logs; set Records per page to 50 and click through the pages once to keep them all), View battle on arena duels, Squadron Groups and the Map. It only reads what the game already shows you: it sends nothing and clicks nothing.');
    h += line('Kept whole in this browser (about 0.1 MB a squadron battle), for the player picker in the planner, squadron simulator and group builder. Nothing leaves your computer unless you download it or open the planner.', 'mu');
    h += '<div class="row"><label class="c"><input type="checkbox" id="f_arc"' + (S.inputs.archive === false ? '' : ' checked') + '>Keep battles</label></div>';
    h += '<div class="row"><button class="act" id="b_arcdl">Download archive (.json)</button><button class="act" id="b_arcclr">Clear archive</button></div>';
    h += line('Open in planner sends a small card per player (not the raw logs) to the web planner, where you can plan against one player or a whole squadron.', 'mu');
    return h + plRow();
  }

  arcCount().catch(function (e) { ARC.err = String((e && e.message) || e); });

  /* ============================================================
     THE PANEL
     ============================================================ */

  var view = 'pvp';   // 'pvp' or 'set'
  var EXTRA_CSS = '#btn{gap:6px}#btn .sw{font-size:13px;line-height:1}';

  var hostEl = document.createElement('div');
  hostEl.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646';
  var shadow = hostEl.attachShadow({ mode: 'open' });
  var cssEl = document.createElement('style'); cssEl.textContent = CSS + EXTRA_CSS; shadow.appendChild(cssEl);
  var root = document.createElement('div');
  root.className = 'root ' + (THEME === 'dark' ? 'dark' : 'light');
  shadow.appendChild(root);

  var btn = document.createElement('div');
  btn.id = 'btn'; btn.innerHTML = '<span class="dot"></span><span class="sw">⚔</span>PvP Meta';
  btn.style.left = '170px';
  root.appendChild(btn);

  var panel = document.createElement('div');
  panel.id = 'panel'; panel.style.display = 'none'; panel.style.left = '170px';
  panel.innerHTML =
    '<div id="bar"><span class="ttl"><b>⚔ PvP Meta</b><span class="ver">v' + esc(scriptVersion()) + '</span></span><span class="ctl">' +
    '<span class="g" id="settings" title="Settings">&#9881;</span>' +
    '<span class="g" id="theme" title="Light / dark">&#9680;</span>' +
    '<span class="g" id="close">hide</span></span></div><div id="body"></div>';
  root.appendChild(panel);

  function mount() { if (document.body && !document.body.contains(hostEl)) document.body.appendChild(hostEl); }
  mount();
  setInterval(mount, 2000);

  draggable(btn, btn, 'btnPos', function () {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    if (panel.style.display === 'flex') { refresh(); render(); }
  });
  draggable(panel, panel.querySelector('#bar'), 'panelPos', null);
  panel.querySelector('#close').addEventListener('click', function (e) { e.stopPropagation(); panel.style.display = 'none'; });
  panel.querySelector('#theme').addEventListener('click', function (e) {
    e.stopPropagation();
    THEME = THEME === 'dark' ? 'light' : 'dark';
    root.className = 'root ' + THEME;
    store.set('theme', THEME);
  });
  panel.querySelector('#settings').addEventListener('click', function (e) { e.stopPropagation(); view = view === 'set' ? 'pvp' : 'set'; render(); });

  // The recorder and the planner check tab === 'battle' before redrawing.
  var tab = 'battle';

  function refresh() {
    var st = recState();
    S.storeState = st;
    S.storeOk = !!(st && st.UserStore && st.UserStore.player);
  }

  function numField(id, label, key) {
    return '<label>' + esc(label) + '<input type="number" step="any" id="' + id + '" value="' + esc(String(S.inputs[key])) + '"></label>';
  }

  function renderSet() {
    var h = sect('Battle plan') + '<div class="grid">' +
      numField('f_kb', 'Badges to keep', 'keepBadges') +
      numField('f_gap', 'Least gain worth a change (win %)', 'bestGap') + '</div>';
    h += '<div class="row"><label class="c"><input type="checkbox" id="f_rec"' + (S.inputs.recBattles === false ? '' : ' checked') + '>Record duels</label></div>';
    h += kvs([['Duels stored', String(S.battles.length) + ' / ' + AR_MAX], ['Background worker', S.wkFail ? 'refused: ' + S.wkFail : 'ok']]);
    h += line('Reads your build and your arena duels from the game page. It makes no network request of any kind and never clicks or acts in the game.');
    h += line('Its duels are its own: Astrolabe keeps a separate record, and neither script can see the other\'s.', 'mu');
    h += renderArchive();
    h += '<div class="row"><button class="act" id="b_back">Back</button></div>';
    return h;
  }

  function render() {
    try { render0(); } catch (e) { setErr('drawing the panel failed: ' + ((e && e.message) || e)); }
  }

  function render0() {
    btn.className = S.lastErr ? 'bad' : (S.storeOk ? 'ok' : '');
    panel.querySelector('#settings').className = 'g' + (view === 'set' ? ' on' : '');
    if (panel.style.display === 'none') return;
    var body = panel.querySelector('#body'), keep = body.scrollTop;
    var h = view === 'set' ? renderSet() : renderBattle();
    if (S.lastErr && view !== 'set' && !pvFailed) h += line(S.lastErr, 'bad');
    body.innerHTML = h;
    body.scrollTop = keep;
    wire();
  }

  function wire() {
    function on(id, fn, ev) { var el = panel.querySelector(id); if (el) el.addEventListener(ev || 'click', fn); }
    panel.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = b.getAttribute('data-sub');
        if (s) { bsub = s; bshow = false; }
        render();
      });
    });
    on('#b_showbest', function () { bshow = true; render(); });
    on('#f_rec', function () { S.inputs.recBattles = panel.querySelector('#f_rec').checked; saveInputs(); render(); }, 'change');
    on('#b_clearrec', function () {
      if (!confirm('Clear the recorded duels? The Best build needs them.')) return;
      S.battles = []; store.set('battles', []); pvMemo = { key: null, plan: null }; pvCheck = {}; pvFailed = null; recSeen = null; recTries = { fp: null, n: 0 }; render();
    });
    [['#f_kb', 'keepBadges'], ['#f_gap', 'bestGap']].forEach(function (f) {
      on(f[0], function () {
        var v = numOr(panel.querySelector(f[0]).value);
        S.inputs[f[1]] = v === null ? PVP_DEFAULTS[f[1]] : Math.max(0, v);
        saveInputs();
      }, 'change');
    });
    on('#b_back', function () { view = 'pvp'; render(); });
    on('#f_arc', function () { S.inputs.archive = panel.querySelector('#f_arc').checked; saveInputs(); render(); }, 'change');
    on('#b_plopen', plOpen);
    on('#b_arcdl', function () { arcDownload().catch(function (e) { ARC.err = 'download failed: ' + ((e && e.message) || e); render(); }); });
    on('#b_arcclr', function () {
      if (!confirm('Clear the battle archive? Every saved squadron battle, arena duel, roster and map snapshot is deleted from this browser.')) return;
      arcClear().then(render, function (e) { ARC.err = String((e && e.message) || e); render(); });
    });
  }

  /* ---- timers ---- */
  // Duels: one guarded look a second at the game's loaded-duel slot.
  setInterval(function () {
    try { recTick(); } catch (e) { setErr('recording the duel failed: ' + ((e && e.message) || e)); }
    try { arcDuelTick(); } catch (e) { ARC.err = String((e && e.message) || e); }
  }, REC_WATCH_MS);
  // The build: every 10 s while the panel is open (Settings is left alone,
  // so a redraw does not throw away what is being typed).
  setInterval(function () {
    if (S.lastErr && S.lastErrAt && Date.now() - S.lastErrAt > 600000) setErr(null);
    refresh();
    if (panel.style.display !== 'none' && view !== 'set') render(); else render0();
  }, 10000);

  refresh();
  render();
})();
