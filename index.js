
// ren_keiba_ai_worker.js
// 蓮競馬AI - Cloudflare Workers 完成版
//
// 機能:
// - iPhoneホーム画面に追加してアプリ風に使えるPWA
// - 毎日「明日」の中央競馬＋地方競馬を自動取得
// - 今日/明日の切替
// - AIレース判定
// - AI印 ◎○▲△☆
// - 単勝/複勝/ワイド/馬連/馬単/3連複/3連単
// - 券種ごとの本命/穴/大穴 点数設定
// - 点数厳密モード
// - まとめられる買い目だけまとめ、余計な買い目は増やさない
// - データ不足なら予想保留
//
// GitHub連携Cloudflare用。iPhoneからサイトとして使います。

const APP_NAME = "蓮競馬AI";
const TZ = "Asia/Tokyo";

const NAR_VENUES = [
  { code: "03", name: "帯広" },
  { code: "10", name: "盛岡" },
  { code: "11", name: "水沢" },
  { code: "18", name: "浦和" },
  { code: "19", name: "船橋" },
  { code: "20", name: "大井" },
  { code: "21", name: "川崎" },
  { code: "22", name: "金沢" },
  { code: "23", name: "笠松" },
  { code: "24", name: "名古屋" },
  { code: "27", name: "園田" },
  { code: "28", name: "姫路" },
  { code: "31", name: "高知" },
  { code: "32", name: "佐賀" },
  { code: "36", name: "門別" },
];

const JRA_VENUES = [
  { code: "01", name: "札幌" },
  { code: "02", name: "函館" },
  { code: "03", name: "福島" },
  { code: "04", name: "新潟" },
  { code: "05", name: "東京" },
  { code: "06", name: "中山" },
  { code: "07", name: "中京" },
  { code: "08", name: "京都" },
  { code: "09", name: "阪神" },
  { code: "10", name: "小倉" },
];

const DEFAULT_POINTS = {
  tan:   { honmei: 1, ana: 1, oogana: 0 },
  fuku:  { honmei: 2, ana: 2, oogana: 1 },
  wide:  { honmei: 3, ana: 3, oogana: 2 },
  umaren:{ honmei: 3, ana: 4, oogana: 2 },
  umatan:{ honmei: 4, ana: 4, oogana: 2 },
  sanrenpuku: { honmei: 5, ana: 5, oogana: 3 },
  sanrentan:  { honmei: 10, ana: 8, oogana: 2 },
};

const BET_LABELS = {
  all: "おすすめ全部",
  tan: "単勝",
  fuku: "複勝",
  wide: "ワイド",
  umaren: "馬連",
  umatan: "馬単",
  sanrenpuku: "3連複",
  sanrentan: "3連単",
};

function htmlEscape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function page(html) {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function svg(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

function jstDate(offsetDays = 0) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + offsetDays);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function dateForUrl(dateStr) {
  return encodeURIComponent(dateStr);
}

function ymdParts(dateStr) {
  const [y, m, d] = String(dateStr).split("/").map(Number);
  return {
    y, m, d,
    ymd: `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`,
    mmdd: `${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`,
  };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 ren-keiba-ai/1.0",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`fetch failed ${res.status}`);
  const buf = await res.arrayBuffer();
  const ct = res.headers.get("content-type") || "";
  let text = "";
  try {
    if (/shift|sjis|windows-31j/i.test(ct) || /jra\.go\.jp\/JRADB/i.test(url)) {
      text = new TextDecoder("shift_jis").decode(buf);
    } else {
      text = new TextDecoder("utf-8").decode(buf);
      if ((text.match(/\uFFFD/g) || []).length > 10) {
        text = new TextDecoder("shift_jis").decode(buf);
      }
    }
  } catch (e) {
    text = new TextDecoder("utf-8").decode(buf);
  }
  return text;
}

function stripTags(s) {
  return String(s ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th|tr|p|div|li|h\d|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function narRaceListUrl(code, dateStr) {
  return `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceList?k_babaCode=${code}&k_raceDate=${dateForUrl(dateStr)}`;
}

function narDebaUrl(code, dateStr, raceNo) {
  return `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable?k_babaCode=${code}&k_raceDate=${dateForUrl(dateStr)}&k_raceNo=${raceNo}`;
}

function narOddsUrl(code, dateStr, raceNo) {
  return `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/OddsTanFuku?k_babaCode=${code}&k_raceDate=${dateForUrl(dateStr)}&k_raceNo=${raceNo}`;
}

function jraCalendarUrl(dateStr) {
  const { y, m, mmdd } = ymdParts(dateStr);
  return `https://www.jra.go.jp/keiba/calendar${y}/${y}/${m}/${mmdd}.html`;
}

function jraDebaCname(r) {
  const { y, ymd } = ymdParts(r.date);
  return `pw01dde01${r.code}${y}${String(r.kai).padStart(2, "0")}${String(r.day).padStart(2, "0")}${String(r.r).padStart(2, "0")}${ymd}`;
}

function jraDebaUrl(r) {
  return `https://www.jra.go.jp/JRADB/accessD.html?CNAME=${jraDebaCname(r)}`;
}

function normalizeRaceName(s, fallback) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t || t.length < 2) return fallback;
  if (/出馬表|オッズ|レース結果|払戻|メニュー|映像|開催|一覧/.test(t)) return fallback;
  return t.slice(0, 40);
}

function parseNarRaceList(html, venue, dateStr) {
  const races = [];
  const clean = stripTags(html);
  if (clean.includes("開催はありません") || clean.includes("発売はありません")) return races;

  const htmlNums = [...html.matchAll(/k_raceNo=(\d+)/g)]
    .map(m => Number(m[1]))
    .filter(n => n >= 1 && n <= 12);
  const uniqueNums = [...new Set(htmlNums)].sort((a, b) => a - b);

  const lines = clean.split(/\n+/).map(x => x.trim()).filter(Boolean);

  for (const no of uniqueNums) {
    let name = `${venue.name}${no}R`;
    let time = "";
    let course = "";
    let heads = null;

    const idxs = [];
    lines.forEach((l, i) => {
      if (new RegExp(`(^|\\s)${no}R(\\s|$|：|:)`).test(l) || l.includes(`${no}R`)) idxs.push(i);
    });
    const around = idxs.length
      ? lines.slice(Math.max(0, idxs[0] - 3), Math.min(lines.length, idxs[0] + 10))
      : lines;

    for (const l of around) {
      const tm = l.match(/(\d{1,2}:\d{2})/);
      if (tm && !time) time = tm[1];

      const cm = l.match(/(右|左|直線)?\s*(ダ|芝)?\s*(\d{3,4})m/);
      if (cm && !course) course = cm[0].replace(/\s+/g, "");

      const hm = l.match(/(\d{1,2})頭/);
      if (hm && !heads) heads = Number(hm[1]);

      if (!l.includes("発走") && !l.includes("オッズ") && !l.includes("出馬表") && l.length >= 3 && l.length <= 45) {
        name = normalizeRaceName(l.replace(new RegExp(`^${no}R\\s*`), ""), name);
      }
    }

    races.push({
      source: "nar",
      sourceLabel: "地方",
      place: venue.name,
      code: venue.code,
      r: no,
      date: dateStr,
      time,
      name,
      course,
      heads,
      officialUrl: narDebaUrl(venue.code, dateStr, no),
    });
  }

  return races;
}

async function getNarRaces(dateStr) {
  const out = [];
  await Promise.all(NAR_VENUES.map(async venue => {
    try {
      const h = await fetchText(narRaceListUrl(venue.code, dateStr));
      const parsed = parseNarRaceList(h, venue, dateStr);
      if (parsed.length) out.push(...parsed);
    } catch (e) {}
  }));
  return out;
}

function parseJraCalendar(html, dateStr) {
  const text = stripTags(html);
  const found = [];
  const re = /(\d+)回\s*(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\s*(\d+)日/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const venue = JRA_VENUES.find(v => v.name === m[2]);
    if (!venue) continue;
    const key = `${venue.name}-${m[1]}-${m[3]}`;
    if (found.some(x => x.key === key)) continue;
    found.push({
      key,
      code: venue.code,
      name: venue.name,
      kai: Number(m[1]),
      day: Number(m[3]),
    });
  }

  const races = [];
  for (const v of found) {
    for (let no = 1; no <= 12; no++) {
      const r = {
        source: "jra",
        sourceLabel: "中央",
        place: v.name,
        code: v.code,
        kai: v.kai,
        day: v.day,
        r: no,
        date: dateStr,
        time: "",
        name: `${v.name}${no}R`,
        course: "JRA",
        heads: null,
      };
      r.officialUrl = jraDebaUrl(r);
      races.push(r);
    }
  }
  return races;
}

async function getJraRaces(dateStr) {
  try {
    const html = await fetchText(jraCalendarUrl(dateStr));
    return parseJraCalendar(html, dateStr);
  } catch (e) {
    return [];
  }
}

async function getRaces(dateStr) {
  const [jra, nar] = await Promise.all([
    getJraRaces(dateStr),
    getNarRaces(dateStr),
  ]);
  const out = [...jra, ...nar];

  out.sort((a, b) => {
    const sourceOrder = x => x.source === "jra" ? 0 : 1;
    if (sourceOrder(a) !== sourceOrder(b)) return sourceOrder(a) - sourceOrder(b);
    const ta = a.time || "99:99";
    const tb = b.time || "99:99";
    if (ta !== tb) return ta.localeCompare(tb);
    if (a.place !== b.place) return a.place.localeCompare(b.place, "ja");
    return a.r - b.r;
  });

  return out;
}

function parseRecord(chunk, label) {
  const re = new RegExp(`${label}\\s*([0-9]+)\\s*-\\s*([0-9]+)\\s*-\\s*([0-9]+)\\s*-\\s*([0-9]+)`);
  const m = chunk.match(re);
  if (!m) return { w:0, s:0, t:0, o:0, total:0, win:0, top3:0 };
  const w = Number(m[1]), se = Number(m[2]), th = Number(m[3]), o = Number(m[4]);
  const total = w + se + th + o;
  return { w, s:se, t:th, o, total, win: total ? w / total : 0, top3: total ? (w + se + th) / total : 0 };
}

function parseOddsText(html) {
  const text = stripTags(html);
  const odds = {};
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const s = lines.slice(i, i + 5).join(" ");
    const m = s.match(/(^|\s)(\d{1,2})\s+[^0-9\s]{2,24}\s+(\d+(?:\.\d+)?)\s+(\d{1,2})/);
    if (m) odds[Number(m[2])] = { odds: Number(m[3]), pop: Number(m[4]) };
  }
  return odds;
}

function extractRunningStyle(finishNums, chunk) {
  const c = String(chunk || "");
  if (/逃げ|ハナ|先頭/.test(c)) return "逃げ";
  if (/先行|好位/.test(c)) return "先行";
  if (/差し|中団/.test(c)) return "差し";
  if (/追込|後方/.test(c)) return "追込";

  // 近走着順が安定している人気馬は好位寄り、荒れている馬は差し/追込寄りの仮判定
  if (finishNums.length >= 3) {
    const avg = finishNums.slice(0, 5).reduce((a,b)=>a+b,0) / Math.min(5, finishNums.length);
    if (avg <= 3.5) return "先行";
    if (avg >= 8) return "差し";
  }
  return "不明";
}

function bloodlineScore(chunk, raceInfo) {
  const c = String(chunk || "");
  let score = 0;
  const reasons = [];

  const isDirt = /ダ|ダート/.test(raceInfo.course || "");
  const isTurf = /芝/.test(raceInfo.course || "");
  const dist = Number((String(raceInfo.course || "").match(/(\d{3,4})m/) || [])[1] || 0);

  const staminaSires = ["ハーツクライ","ルーラーシップ","キングカメハメハ","エピファネイア","ドゥラメンテ","キズナ","ステイゴールド","オルフェーヴル"];
  const speedSires = ["ロードカナロア","サクラバクシンオー","ダイワメジャー","ミッキーアイル","ビッグアーサー"];
  const dirtSires = ["シニスターミニスター","ヘニーヒューズ","パイロ","ホッコータルマエ","ゴールドアリュール","アジアエクスプレス","マジェスティックウォリアー"];
  const powerSires = ["キンシャサノキセキ","クロフネ","サウスヴィグラス","コパノリッキー"];

  if (isDirt) {
    for (const s of dirtSires) if (c.includes(s)) { score += 1.1; reasons.push("ダート血統○"); break; }
    for (const s of powerSires) if (c.includes(s)) { score += 0.6; reasons.push("パワー血統○"); break; }
  }
  if (isTurf) {
    for (const s of staminaSires) if (c.includes(s)) { score += dist >= 1800 ? 0.9 : 0.45; reasons.push("芝中長距離血統○"); break; }
    for (const s of speedSires) if (c.includes(s)) { score += dist <= 1600 ? 0.8 : -0.15; reasons.push("スピード血統"); break; }
  }

  if (/重|不良|稍重/.test(c)) {
    score += 0.2;
    reasons.push("道悪経験");
  }

  return { score, reason: reasons.slice(0,2).join(" / ") };
}

function extractNarHorses(html, oddsMap, raceInfo) {
  const text = stripTags(html);
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  let start = lines.findIndex(x => x.includes("枠番") && x.includes("馬番"));
  if (start < 0) start = 0;
  const joined = lines.slice(start).join("\n");

  const rowMatches = [...joined.matchAll(/(?:^|\n)\s*(\d{1,2})\s+(\d{1,2})\s+([ァ-ヶー一-龥A-Za-z0-9・ー\.\-]{2,24})\s/g)];
  const chunks = [];

  if (rowMatches.length >= 3) {
    for (let i = 0; i < rowMatches.length; i++) {
      const m = rowMatches[i];
      const from = m.index || 0;
      const to = i + 1 < rowMatches.length ? (rowMatches[i + 1].index || joined.length) : joined.length;
      const gate = Number(m[1]), no = Number(m[2]), name = m[3];
      if (no >= 1 && no <= 18 && gate >= 1 && gate <= 8) {
        chunks.push({ gate, no, name, text: joined.slice(from, to) });
      }
    }
  }

  const seen = new Set();
  const horses = [];

  for (const c of chunks) {
    if (seen.has(c.no)) continue;
    seen.add(c.no);
    const chunk = c.text;
    if (/出走取消|競走除外/.test(chunk)) continue;

    let odds = oddsMap[c.no]?.odds ?? null;
    let pop = oddsMap[c.no]?.pop ?? null;

    const oddM = chunk.match(/(\d+(?:\.\d+)?)\s*\(?\s*(\d{1,2})人気\s*\)?/);
    if (oddM) {
      odds = Number(oddM[1]);
      pop = Number(oddM[2]);
    }

    const all = parseRecord(chunk, "全");
    const place = parseRecord(chunk, "場");
    const dist = parseRecord(chunk, "距");

    const finishNums = [];
    const recentLines = chunk.match(/(?:^|\n)\s*([1-9][0-9]?)\s+\d{2}\.\d{2}\.\d{2}/g);
    if (recentLines) {
      recentLines.forEach(x => {
        const n = Number((x.match(/[1-9][0-9]?/) || [])[0]);
        if (n > 0 && n < 30) finishNums.push(n);
      });
    }

    const weightM = chunk.match(/\b(\d{3})\s*\(([+\-－−]?\d+)\)/);
    const bw = weightM ? Number(weightM[1]) : null;
    const bwc = weightM ? Number(String(weightM[2]).replace("－","-").replace("−","-")) : null;

    const blood = bloodlineScore(chunk, raceInfo);
    const style = extractRunningStyle(finishNums, chunk);

    horses.push({
      no: c.no,
      gate: c.gate,
      name: c.name,
      odds: odds || null,
      pop: pop || null,
      all,
      place,
      dist,
      finishNums,
      bw,
      bwc,
      bloodScore: blood.score,
      bloodReason: blood.reason,
      style,
      raw: chunk,
    });
  }

  return horses.filter(h => h.name && !/^(出馬表|オッズ|成績|払戻|競走成績|映像)$/.test(h.name)).slice(0, 18);
}

function extractJraHorses(html, raceInfo) {
  const text = stripTags(html);
  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const joined = lines.join("\n");

  const rowMatches = [...joined.matchAll(/(?:^|\n)\s*(\d{1,2})\s+([ァ-ヶー一-龥A-Za-z0-9・ー\.\-]{2,24})\s+(牡|牝|せん|セ|騙)?\s*\d?/g)];
  const horses = [];
  const seen = new Set();

  for (let i = 0; i < rowMatches.length; i++) {
    const m = rowMatches[i];
    const no = Number(m[1]);
    const name = m[2];
    if (!no || no > 18 || seen.has(no)) continue;
    if (/^(出馬表|オッズ|人気|枠|馬番|馬名|騎手|斤量|父|母|前走|成績|払戻|レース)$/.test(name)) continue;

    const from = m.index || 0;
    const to = i + 1 < rowMatches.length ? (rowMatches[i+1].index || joined.length) : Math.min(joined.length, from + 1800);
    const chunk = joined.slice(from, to);
    if (/出走取消|競走除外/.test(chunk)) continue;

    const oddM = chunk.match(/(\d+(?:\.\d+)?)\s*\(?\s*(\d{1,2})番人気\s*\)?/) || chunk.match(/(\d+(?:\.\d+)?)\s*\(?\s*(\d{1,2})人気\s*\)?/);
    const odds = oddM ? Number(oddM[1]) : null;
    const pop = oddM ? Number(oddM[2]) : null;

    const finishNums = [];
    const recent = [...chunk.matchAll(/([1-9][0-9]?)着/g)].slice(0, 5);
    for (const r of recent) {
      const n = Number(r[1]);
      if (n > 0 && n < 30) finishNums.push(n);
    }

    const blood = bloodlineScore(chunk, raceInfo);
    const style = extractRunningStyle(finishNums, chunk);

    horses.push({
      no,
      gate: 0,
      name,
      odds,
      pop,
      all: { w:0, s:0, t:0, o:0, total:0, win:0, top3:0 },
      place: { w:0, s:0, t:0, o:0, total:0, win:0, top3:0 },
      dist: { w:0, s:0, t:0, o:0, total:0, win:0, top3:0 },
      finishNums,
      bw: null,
      bwc: null,
      bloodScore: blood.score,
      bloodReason: blood.reason,
      style,
      raw: chunk,
    });
    seen.add(no);
  }

  return horses.slice(0, 18);
}

function dataQuality(horses, raceInfo) {
  const reasons = [];
  if (!horses || horses.length < 3) reasons.push("出走馬の読み取り不足");
  const oddsCount = horses.filter(h => h.odds && h.pop).length;
  const recentCount = horses.filter(h => h.finishNums && h.finishNums.length).length;
  const recordCount = horses.filter(h => h.all.total || h.place.total || h.dist.total).length;

  if (oddsCount < Math.max(3, Math.floor(horses.length * 0.3))) reasons.push("オッズ未取得または少なすぎ");
  if (recentCount < Math.max(3, Math.floor(horses.length * 0.35))) reasons.push("近走成績の読み取り不足");
  if (raceInfo.source === "nar" && recordCount < Math.max(2, Math.floor(horses.length * 0.2))) reasons.push("着別成績の読み取り不足");

  return {
    ok: reasons.length === 0,
    reasons,
    status: {
      entries: horses.length >= 3 ? "取得済み" : "不足",
      odds: oddsCount ? `取得 ${oddsCount}/${horses.length}` : "未取得",
      recent: recentCount ? `取得 ${recentCount}/${horses.length}` : "不足",
      records: recordCount ? `取得 ${recordCount}/${horses.length}` : "不足",
      weight: horses.some(h => h.bw) ? "一部取得" : "発表前/未取得",
      bloodline: horses.some(h => h.bloodReason) ? "一部取得" : "未取得",
    }
  };
}

function inferCourseTraits(raceInfo) {
  const place = raceInfo.place || "";
  const course = raceInfo.course || "";
  const isDirt = /ダ|ダート/.test(course);
  const isTurf = /芝/.test(course);
  const dist = Number((String(course).match(/(\d{3,4})m/) || [])[1] || 0);

  const traits = [];
  let insideBias = 0;
  let frontBias = 0;
  let staminaBias = 0;
  let speedBias = 0;

  if (["大井","園田","姫路","浦和","船橋","川崎","高知","佐賀","金沢","笠松","名古屋"].includes(place)) {
    traits.push("地方小回り");
    frontBias += 0.5;
    insideBias += 0.25;
  }
  if (place === "東京") {
    traits.push("長い直線");
    staminaBias += dist >= 2000 ? 0.45 : 0.2;
    frontBias -= 0.1;
  }
  if (place === "中山" || place === "阪神") {
    traits.push("坂あり");
    staminaBias += 0.25;
  }
  if (isDirt) {
    traits.push("ダート");
    frontBias += 0.35;
    insideBias += 0.1;
    speedBias += dist <= 1400 ? 0.3 : 0.1;
  }
  if (isTurf) {
    traits.push("芝");
    staminaBias += dist >= 2000 ? 0.35 : 0;
    speedBias += dist <= 1600 ? 0.3 : 0.1;
  }
  if (dist && dist <= 1200) {
    traits.push("短距離");
    speedBias += 0.5;
    frontBias += 0.25;
  }
  if (dist && dist >= 1800) {
    traits.push("中長距離");
    staminaBias += 0.4;
  }

  return { traits, insideBias, frontBias, staminaBias, speedBias, dist, isDirt, isTurf };
}

function styleScoreForRace(style, traits) {
  if (style === "逃げ") return 0.6 + traits.frontBias;
  if (style === "先行") return 0.45 + traits.frontBias * 0.8;
  if (style === "差し") return 0.25 - traits.frontBias * 0.35 + (traits.traits.includes("長い直線") ? 0.35 : 0);
  if (style === "追込") return -0.1 - traits.frontBias * 0.45 + (traits.traits.includes("長い直線") ? 0.25 : 0);
  return 0;
}

function scoreHorse(h, raceInfo) {
  const traits = inferCourseTraits(raceInfo);

  const recentScore = h.finishNums.length
    ? h.finishNums.slice(0, 5).map((f, i) => Math.max(0, 13 - f) / (i + 1)).reduce((a,b)=>a+b,0) / 3.5
    : 0;

  const ability = (h.all.total ? (h.all.win * 3.2 + h.all.top3 * 2.0) : 0.7) + recentScore;
  const course = h.place.total ? (h.place.win * 2.2 + h.place.top3 * 1.2) : 0;
  const distance = h.dist.total ? (h.dist.win * 2.4 + h.dist.top3 * 1.4) : 0;
  const style = styleScoreForRace(h.style, traits);
  const gate = h.gate ? ((h.gate <= 3 ? 0.25 : h.gate >= 7 ? -0.05 : 0) + traits.insideBias * (h.gate <= 4 ? 0.6 : -0.2)) : 0;
  const blood = h.bloodScore || 0;

  const odds = h.odds || (18 + h.no * 1.7);
  const pop = h.pop || Math.min(12, h.no + 5);
  const oddsBase = Math.max(0, 3.0 - Math.log(Math.max(1.1, odds)) * 0.85);
  const popBase = Math.max(0, 2.3 - pop * 0.16);
  const bodyPenalty = h.bwc === null || h.bwc === undefined ? 0 : Math.abs(h.bwc) >= 20 ? -0.55 : Math.abs(h.bwc) >= 12 ? -0.22 : 0;
  const valueBoost = (odds >= 12 && recentScore > 1.2) ? 0.35 : 0;

  const score = ability + course + distance + style + gate + blood + oddsBase + popBase + bodyPenalty + valueBoost;

  const parts = [];
  if (h.all.total) parts.push(`全${h.all.w}-${h.all.s}-${h.all.t}-${h.all.o}`);
  if (h.place.total) parts.push(`場${h.place.w}-${h.place.s}-${h.place.t}-${h.place.o}`);
  if (h.dist.total) parts.push(`距${h.dist.w}-${h.dist.s}-${h.dist.t}-${h.dist.o}`);
  if (h.finishNums.length) parts.push(`近走${h.finishNums.slice(0,5).join("-")}着`);
  if (h.bloodReason) parts.push(h.bloodReason);
  if (h.style !== "不明") parts.push(`${h.style}脚質`);
  parts.push(`単勝${Math.round(odds*10)/10}/${pop}人気`);

  const categories = {
    ability: Math.round(Math.min(25, Math.max(0, ability * 4.2)) * 10) / 10,
    course: Math.round(Math.min(15, Math.max(0, (course + distance + gate) * 4.0)) * 10) / 10,
    pace: Math.round(Math.min(15, Math.max(0, (style + 1.0) * 5.0)) * 10) / 10,
    bias: Math.round(Math.min(10, Math.max(0, (gate + traits.frontBias + 0.5) * 3.5)) * 10) / 10,
    ground: Math.round(Math.min(10, Math.max(0, (traits.staminaBias + traits.speedBias + 0.8) * 3.2)) * 10) / 10,
    blood: Math.round(Math.min(10, Math.max(0, (blood + 1.0) * 3.5)) * 10) / 10,
    value: Math.round(Math.min(5, Math.max(0, valueBoost * 8 + (odds >= 10 ? 1.2 : 0.4))) * 10) / 10,
  };

  return {
    ...h,
    odds,
    pop,
    score,
    ai100: Math.round(Math.min(99.9, Math.max(1, score * 8.8)) * 10) / 10,
    reason: parts.join(" / "),
    categories,
  };
}

function raceJudgement(scored, raceInfo) {
  const traits = inferCourseTraits(raceInfo);
  const top = scored[0];
  const second = scored[1];
  const third = scored[2];

  const gap12 = top && second ? top.score - second.score : 0;
  const gap13 = top && third ? top.score - third.score : 0;
  const longshots = scored.filter(h => h.odds >= 12 || h.pop >= 7).slice(0, 5);
  const frontCount = scored.filter(h => h.style === "逃げ" || h.style === "先行").length;
  const diffCount = scored.filter(h => h.style === "差し" || h.style === "追込").length;

  let rough = 50;
  if (gap12 > 1.4) rough -= 12;
  if (gap13 > 2.2) rough -= 8;
  if (longshots.length >= 3) rough += 12;
  if (frontCount >= 5) rough += 8;
  if (raceInfo.source === "nar") rough += 4;
  rough = Math.max(10, Math.min(90, rough));

  const roughLabel = rough < 35 ? "低" : rough < 60 ? "中" : "高";
  const axis = gap12 > 1.2 ? "高め" : gap12 > 0.5 ? "中" : "低め";
  const pace = frontCount <= 2 ? "逃げ先行少なめでスロー寄り" :
               frontCount >= 5 ? "先行馬多めで流れやすい" :
               "標準ペース想定";
  const bias = traits.frontBias >= 0.65 ? "内前・先行有利" :
               traits.traits.includes("長い直線") ? "差しも届くコース" :
               "極端な偏りは小さめ";

  const dangerous = scored
    .filter(h => h.pop <= 3 && h.score < (scored[0]?.score || 0) - 1.0)
    .slice(0, 2)
    .map(h => `${h.no}番 ${h.name}`);

  const hole = scored
    .filter(h => (h.odds >= 10 || h.pop >= 6) && h.rank <= 8)
    .slice(0, 3)
    .map(h => `${h.no}番 ${h.name}`);

  const blood = scored
    .filter(h => h.bloodReason)
    .slice(0, 3)
    .map(h => `${h.no}番 ${h.name}`);

  const recommended = roughLabel === "低" ? ["単勝", "馬連", "3連複"] :
                      roughLabel === "中" ? ["ワイド", "3連複", "3連単少額"] :
                      ["ワイド", "3連複", "穴3連単"];

  return {
    rough,
    roughLabel,
    axis,
    pace,
    bias,
    dangerous,
    hole,
    blood,
    recommended,
    traits: traits.traits,
  };
}

async function predictNarRace(code, dateStr, raceNo) {
  const raceInfo = { source:"nar", code, date: dateStr, r: raceNo, course:"" };
  const [deba, odds] = await Promise.all([
    fetchText(narDebaUrl(code, dateStr, raceNo)),
    fetchText(narOddsUrl(code, dateStr, raceNo)).catch(() => ""),
  ]);
  const oddsMap = odds ? parseOddsText(odds) : {};
  const horses = extractNarHorses(deba, oddsMap, raceInfo);
  return buildPrediction(horses, raceInfo);
}

async function predictJraRace(code, dateStr, raceNo, kai, day) {
  if (!kai || !day) {
    throw new Error("JRAの開催回・開催日が取得できませんでした。出馬表公開後に再実行してください。");
  }
  const raceInfo = { source:"jra", code, date: dateStr, r: raceNo, kai, day, course:"JRA" };
  const deba = await fetchText(jraDebaUrl(raceInfo));
  const horses = extractJraHorses(deba, raceInfo);
  return buildPrediction(horses, raceInfo);
}

function buildPrediction(horses, raceInfo) {
  const quality = dataQuality(horses, raceInfo);
  if (!quality.ok) {
    return {
      status: "hold",
      quality,
      horses: [],
      judgement: null,
      tickets: {},
      message: "精度不足：予想保留",
    };
  }

  const scored = horses
    .map(h => scoreHorse(h, raceInfo))
    .sort((a,b)=>b.score-a.score)
    .map((h,i)=>({ ...h, rank:i+1, score: Math.round(h.score*100)/100 }));

  const judgement = raceJudgement(scored, raceInfo);
  const tickets = buildAllTickets(scored);

  return {
    status: "ok",
    quality,
    horses: scored,
    judgement,
    tickets,
    message: "AI予想完了",
  };
}

function combinations(arr, k) {
  const res = [];
  const rec = (start, path) => {
    if (path.length === k) { res.push(path.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      path.push(arr[i]);
      rec(i + 1, path);
      path.pop();
    }
  };
  rec(0, []);
  return res;
}

function permutations(arr, k) {
  const res = [];
  const used = new Set();
  const rec = (path) => {
    if (path.length === k) { res.push(path.slice()); return; }
    for (const x of arr) {
      if (used.has(x.no)) continue;
      used.add(x.no);
      path.push(x);
      rec(path);
      path.pop();
      used.delete(x.no);
    }
  };
  rec([]);
  return res;
}

function scoreCombo(items, type, group) {
  const base = items.reduce((a,h,i) => a + h.score * (i === 0 ? 0.55 : i === 1 ? 0.30 : 0.15), 0);
  const odds = items.reduce((a,h,i)=>a * Math.pow(Math.max(1.1, h.odds || 15), i === 0 ? 0.45 : 0.32), 1);
  const long = items.filter(h => h.odds >= 12 || h.pop >= 6).length;
  let g = 0;
  if (group === "honmei") g = base - long * 0.45 - Math.log(odds) * 0.05;
  if (group === "ana") g = base + Math.log(odds) * 0.18 - Math.max(0,long-2) * 0.25;
  if (group === "oogana") g = base + Math.log(odds) * 0.38 + long * 0.25;
  return g;
}

function makeRawTickets(scored, type, group, limit) {
  const top = scored.slice(0, Math.min(10, scored.length));
  let pool = top;
  if (group === "honmei") pool = scored.slice(0, Math.min(6, scored.length));
  if (group === "ana") pool = scored.slice(0, Math.min(9, scored.length));
  if (group === "oogana") pool = scored.slice(0, Math.min(12, scored.length));

  let rows = [];

  if (type === "tan" || type === "fuku") {
    rows = pool.map(h => ({ key: `${h.no}`, horses:[h], score:scoreCombo([h],type,group) }));
  } else if (type === "wide" || type === "umaren") {
    rows = combinations(pool,2).map(c => ({ key: `${c[0].no}-${c[1].no}`, horses:c, score:scoreCombo(c,type,group) }));
  } else if (type === "umatan") {
    rows = permutations(pool,2).map(c => ({ key: `${c[0].no}→${c[1].no}`, horses:c, score:scoreCombo(c,type,group) }));
  } else if (type === "sanrenpuku") {
    rows = combinations(pool,3).map(c => ({ key: `${c[0].no}-${c[1].no}-${c[2].no}`, horses:c, score:scoreCombo(c,type,group) }));
  } else if (type === "sanrentan") {
    rows = permutations(pool,3).map(c => ({ key: `${c[0].no}→${c[1].no}→${c[2].no}`, horses:c, score:scoreCombo(c,type,group) }));
  }

  // グループ別の条件
  rows = rows.filter(r => {
    const long = r.horses.filter(h => h.odds >= 12 || h.pop >= 6).length;
    if (group === "honmei") return long <= 1;
    if (group === "ana") return long >= 1;
    if (group === "oogana") return long >= 1 && r.horses.some(h => h.odds >= 15 || h.pop >= 8);
    return true;
  });

  rows.sort((a,b)=>b.score-a.score);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

function compressTickets(type, tickets) {
  // 点数厳密。余計な買い目が増えない完全一致の時だけまとめる。
  const keys = tickets.map(t => t.key);
  if (!keys.length) return [];

  if (type === "tan" || type === "fuku") {
    return [{ kind:"個別指定", count: keys.length, lines: keys, exact:true }];
  }

  if (type === "wide" || type === "umaren") {
    const pairs = tickets.map(t => t.horses.map(h=>h.no));
    const allNos = [...new Set(pairs.flat())];
    for (const axis of allNos) {
      const others = pairs.filter(p => p.includes(axis)).map(p => p.find(n => n !== axis));
      if (others.length === pairs.length && new Set(others).size === pairs.length) {
        return [{ kind:"流し", count:pairs.length, axis:[axis], opponents:others, exact:true }];
      }
    }
    return [{ kind:"個別指定", count:keys.length, lines:keys, exact:true }];
  }

  if (type === "umatan") {
    const pairs = tickets.map(t => t.horses.map(h=>h.no));
    const firsts = [...new Set(pairs.map(p=>p[0]))];
    if (firsts.length === 1) {
      return [{ kind:"1着固定流し", count:pairs.length, first:[firsts[0]], second:[...new Set(pairs.map(p=>p[1]))], exact:true }];
    }
    return [{ kind:"個別指定", count:keys.length, lines:keys, exact:true }];
  }

  if (type === "sanrenpuku") {
    const triples = tickets.map(t => t.horses.map(h=>h.no));
    const allNos = [...new Set(triples.flat())];
    for (const axis of allNos) {
      const rows = triples.filter(t => t.includes(axis)).map(t => t.filter(n => n !== axis));
      if (rows.length === triples.length) {
        const opponents = [...new Set(rows.flat())];
        const generated = combinations(opponents.map(no => ({no})),2).map(c => [axis,c[0].no,c[1].no].sort((a,b)=>a-b).join("-")).sort();
        const original = triples.map(t => t.slice().sort((a,b)=>a-b).join("-")).sort();
        if (generated.length === original.length && generated.every((k,i)=>k===original[i])) {
          return [{ kind:"軸1頭流し", count:triples.length, axis:[axis], opponents, exact:true }];
        }
      }
    }
    return [{ kind:"個別指定", count:keys.length, lines:keys, exact:true }];
  }

  if (type === "sanrentan") {
    const triples = tickets.map(t => t.horses.map(h=>h.no));
    const firsts = [...new Set(triples.map(t=>t[0]))];
    if (firsts.length === 1) {
      const f = firsts[0];
      const seconds = [...new Set(triples.map(t=>t[1]))];
      const thirds = [...new Set(triples.map(t=>t[2]))];

      const generated = [];
      for (const s of seconds) {
        for (const th of thirds) {
          if (f !== s && f !== th && s !== th) generated.push(`${f}→${s}→${th}`);
        }
      }
      const original = keys.slice().sort();
      const genSorted = generated.sort();
      if (genSorted.length === original.length && genSorted.every((k,i)=>k===original[i])) {
        return [{ kind:"フォーメーション", count:keys.length, first:[f], second:seconds, third:thirds, exact:true }];
      }
    }

    return [{ kind:"個別指定", count:keys.length, lines:keys, exact:true }];
  }

  return [{ kind:"個別指定", count:keys.length, lines:keys, exact:true }];
}

function buildTicketsForType(scored, type, pointConfig) {
  const groups = [
    { key:"honmei", label:"本命", sub:"当てに行く", count: Number(pointConfig?.honmei ?? DEFAULT_POINTS[type].honmei) },
    { key:"ana", label:"穴", sub:"穴", count: Number(pointConfig?.ana ?? DEFAULT_POINTS[type].ana) },
    { key:"oogana", label:"大穴", sub:"高額配当狙い", count: Number(pointConfig?.oogana ?? DEFAULT_POINTS[type].oogana) },
  ];

  const result = {};
  const used = new Set();

  for (const g of groups) {
    if (!g.count) {
      result[g.key] = { ...g, tickets: [], compressed: [] };
      continue;
    }

    let raw = makeRawTickets(scored, type, g.key, g.count * 4);
    raw = raw.filter(t => !used.has(t.key)).slice(0, g.count);
    for (const t of raw) used.add(t.key);

    result[g.key] = {
      ...g,
      tickets: raw.map(t => ({
        key: t.key,
        names: t.horses.map(h=>`${h.no} ${h.name}`),
        horses: t.horses.map(h=>({ no:h.no, name:h.name })),
      })),
      compressed: compressTickets(type, raw),
    };
  }

  return result;
}

function buildAllTickets(scored) {
  const out = {};
  for (const type of Object.keys(DEFAULT_POINTS)) {
    out[type] = buildTicketsForType(scored, type, DEFAULT_POINTS[type]);
  }
  return out;
}

function appIconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#06160c"/>
      <stop offset="1" stop-color="#0e3b22"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#ffe8a3"/>
      <stop offset=".5" stop-color="#f5c84b"/>
      <stop offset="1" stop-color="#9b6812"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path d="M118 341c78-6 140-46 183-115-71 13-133 50-183 115z" fill="url(#gold)" opacity=".98"/>
  <path d="M104 315c27-85 76-142 152-170-30 65-77 122-152 170z" fill="url(#gold)" opacity=".85"/>
  <path d="M214 94c-9 78 13 143 74 194 3-82-20-146-74-194z" fill="url(#gold)" opacity=".72"/>
  <path d="M277 195c28-49 73-74 134-76-20 56-61 92-134 76z" fill="url(#gold)" opacity=".9"/>
  <path d="M193 350c87 22 159 7 220-47-78-24-150-8-220 47z" fill="url(#gold)" opacity=".8"/>
  <path d="M297 168c46-34 82-34 114-4-32-6-55 5-70 31 17 6 30 19 42 38-34-11-64-9-90 8l-50 40c-17 13-31 13-44 2l35-58c16-26 34-45 63-57z" fill="#051008"/>
  <path d="M308 178c37-28 65-26 90-5-30-3-51 8-63 34 19 4 31 15 40 29-30-11-56-7-81 10l-47 37" fill="none" stroke="url(#gold)" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="256" y="430" text-anchor="middle" font-family="serif" font-size="64" fill="url(#gold)" font-weight="700">蓮AI</text>
</svg>`;
}

function horseHeroSvg() {
  // 画像なしでも必ず馬と騎手が見えるインラインSVG
  return `<svg class="heroHorse" viewBox="0 0 900 430" aria-hidden="true">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
        <stop stop-color="#1a261b"/>
        <stop offset=".6" stop-color="#0c130e"/>
        <stop offset="1" stop-color="#061008"/>
      </linearGradient>
      <linearGradient id="dust" x1="0" y1="0" x2="1" y2="0">
        <stop stop-color="#f5c84b" stop-opacity=".55"/>
        <stop offset="1" stop-color="#f5c84b" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="900" height="430" fill="url(#sky)"/>
    <g opacity=".45">
      <path d="M0 210 C180 135 395 122 900 160" stroke="#8a6b2a" stroke-width="5" fill="none"/>
      <path d="M0 238 C220 168 430 165 900 202" stroke="#67501f" stroke-width="3" fill="none"/>
      <path d="M0 270 C220 216 530 220 900 255" stroke="#544016" stroke-width="2" fill="none"/>
    </g>
    <g opacity=".38">
      ${Array.from({length:18}).map((_,i)=>`<rect x="${i*55}" y="${70+(i%3)*12}" width="34" height="20" fill="#d7c087" opacity=".34"/>`).join("")}
    </g>
    <ellipse cx="610" cy="355" rx="420" ry="65" fill="url(#dust)"/>
    <g transform="translate(290 75) scale(1.15)">
      <path d="M58 189 C28 179 3 158 -25 150 C9 178 19 208 62 214 Z" fill="#060806"/>
      <ellipse cx="190" cy="186" rx="154" ry="64" fill="#2a170c"/>
      <ellipse cx="194" cy="181" rx="144" ry="55" fill="#3b2110"/>
      <path d="M305 160 C340 111 385 91 430 104 C407 124 390 147 374 181 Z" fill="#3a210f"/>
      <ellipse cx="430" cy="96" rx="48" ry="31" fill="#3b2110"/>
      <path d="M468 90 L540 75 L492 112 Z" fill="#271407"/>
      <circle cx="446" cy="92" r="5" fill="#f4d98e"/>
      <path d="M344 124 C363 105 391 93 421 96 C383 120 361 152 349 185 Z" fill="#0b0907"/>
      <path d="M118 233 L85 345 L55 345 L76 224 Z" fill="#1b0f08"/>
      <path d="M176 235 L203 350 L173 350 L140 231 Z" fill="#1b0f08"/>
      <path d="M270 226 L248 348 L218 348 L237 225 Z" fill="#1b0f08"/>
      <path d="M330 210 L395 335 L365 338 L302 221 Z" fill="#1b0f08"/>
      <rect x="45" y="344" width="64" height="11" fill="#100904"/>
      <rect x="160" y="348" width="60" height="11" fill="#100904"/>
      <rect x="208" y="347" width="58" height="11" fill="#100904"/>
      <rect x="356" y="336" width="58" height="11" fill="#100904"/>
      <path d="M143 131 L255 135 L238 176 L134 173 Z" fill="#a81720"/>
      <path d="M160 126 L230 129 L218 158 L152 158 Z" fill="#f5c84b" opacity=".8"/>
      <path d="M195 58 C221 52 247 63 269 92 C244 86 222 88 202 100 Z" fill="#074b35"/>
      <ellipse cx="197" cy="46" rx="25" ry="24" fill="#051008"/>
      <path d="M178 68 L253 95 L236 132 L151 97 Z" fill="#063b2b"/>
      <path d="M161 97 C137 127 128 153 130 176" stroke="#050706" stroke-width="14" fill="none" stroke-linecap="round"/>
      <path d="M238 101 C283 126 316 144 353 158" stroke="#050706" stroke-width="10" fill="none" stroke-linecap="round"/>
      <path d="M300 150 C351 166 393 173 448 155" stroke="#f1d28a" stroke-width="7" fill="none" opacity=".72"/>
    </g>
    <rect x="0" y="340" width="900" height="90" fill="#061008" opacity=".52"/>
  </svg>`;
}

function manifestJson() {
  return JSON.stringify({
    name: APP_NAME,
    short_name: APP_NAME,
    start_url: "/",
    display: "standalone",
    background_color: "#061008",
    theme_color: "#061008",
    icons: [
      { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml" }
    ]
  }, null, 2);
}

function appHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${APP_NAME}</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${APP_NAME}">
<meta name="theme-color" content="#061008">
<style>
:root{
  --bg:#061008;--bg2:#091b10;--card:#0b2818;--card2:#103520;--line:#8c6f2a;
  --text:#fff8e8;--muted:#c8c4ae;--gold:#f5c84b;--gold2:#ffe8a3;
  --red:#b71920;--green:#075831;--ivory:#f7efdb;--ink:#171006;
  --blue:#4bb7e8;--safe:#21d07a;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;color:var(--text);
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic","Yu Gothic UI",sans-serif;
  background:
    radial-gradient(circle at 15% -10%, rgba(245,200,75,.13), transparent 26%),
    radial-gradient(circle at 95% 0%, rgba(33,208,122,.12), transparent 28%),
    linear-gradient(180deg,#031108,#061008 42%,#020704);
}
body:before{
  content:"";position:fixed;inset:0;pointer-events:none;opacity:.06;
  background-image:linear-gradient(90deg,rgba(255,255,255,.22) 1px,transparent 1px),linear-gradient(0deg,rgba(255,255,255,.16) 1px,transparent 1px);
  background-size:48px 48px;
}
header{
  position:sticky;top:0;z-index:20;
  padding:env(safe-area-inset-top) 12px 10px;
  background:rgba(4,28,14,.96);backdrop-filter:blur(14px);
  border-bottom:1px solid rgba(245,200,75,.55);
  box-shadow:0 10px 26px rgba(0,0,0,.36);
}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:56px;height:56px;border-radius:14px;overflow:hidden;flex:0 0 auto}
.logo svg{width:100%;height:100%;display:block}
h1{font-size:30px;line-height:1;margin:0;font-weight:1000;letter-spacing:.06em;color:var(--gold2);text-shadow:0 2px 12px rgba(245,200,75,.18)}
.brandSub{font-size:12px;color:var(--gold);font-weight:1000;letter-spacing:.08em;margin-top:5px}
.headerRight{margin-left:auto;display:flex;align-items:center;gap:14px}
.updateMini{border:1px solid rgba(245,200,75,.55);border-radius:14px;padding:8px 12px;color:var(--gold2);font-size:12px;line-height:1.25;text-align:center;white-space:nowrap}
.menuIcon span{display:block;width:34px;height:4px;background:var(--gold);border-radius:99px;margin:7px 0}
main{padding:0 12px 36px;max-width:960px;margin:0 auto}
.hero{
  position:relative;margin:0 -12px;padding:0 12px 14px;
  border-bottom:1px solid rgba(245,200,75,.45);overflow:hidden;background:#07130c;
}
.heroHorse{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.95}
.heroShade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(2,9,5,.88),rgba(2,9,5,.55) 50%,rgba(2,9,5,.25));}
.heroInner{position:relative;z-index:2;padding:28px 0 8px;min-height:410px}
.copy{color:var(--gold2);font-weight:900;font-size:14px;line-height:1.55;margin:4px 0 14px}
.heroTitle{font-size:44px;line-height:1.12;font-weight:1000;letter-spacing:.02em;text-shadow:0 3px 18px rgba(0,0,0,.65);margin-bottom:22px}
.dataPanel{
  position:absolute;right:12px;top:42px;width:190px;
  background:rgba(2,8,5,.72);border:1px solid rgba(245,200,75,.5);border-radius:14px;padding:12px;
  box-shadow:0 10px 20px rgba(0,0,0,.25);
}
.dataPanelTitle{font-size:13px;color:var(--gold2);font-weight:1000;margin-bottom:8px}
.dataRow{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);padding:4px 0;border-top:1px solid rgba(245,200,75,.15)}
.dataRow b{color:var(--safe)}
.ctas{display:grid;grid-template-columns:1fr 1fr;gap:10px;position:relative;z-index:2}
.cta{
  border:1px solid var(--gold);border-radius:15px;padding:13px 13px;display:flex;align-items:center;gap:10px;
  box-shadow:0 8px 18px rgba(0,0,0,.28);min-height:82px;
}
.cta.red{background:linear-gradient(180deg,#bf2026,#861015)}
.cta.green{background:linear-gradient(180deg,#075831,#06391f)}
.ctaIcon{font-size:28px;color:var(--gold)}
.ctaMain{font-size:20px;font-weight:1000}.ctaSub{font-size:12px;color:#f7e8d0;margin-top:3px}
.card{
  background:linear-gradient(180deg,rgba(11,40,24,.98),rgba(4,22,12,.98));
  border:1px solid rgba(245,200,75,.45);
  border-radius:18px;margin:14px 0;padding:12px;
  box-shadow:0 10px 26px rgba(0,0,0,.28);
}
.sectionHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.sectionTitle{font-size:20px;font-weight:1000;color:var(--gold2)}
.sectionSub{font-size:12px;color:var(--muted)}
.pills{display:flex;gap:7px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;background:rgba(245,200,75,.12);color:var(--gold2);border:1px solid rgba(245,200,75,.32);border-radius:999px;padding:5px 9px;font-size:12px;font-weight:900}
.pill.green{background:rgba(33,208,122,.11);color:#b9ffd8;border-color:rgba(33,208,122,.32)}
.pill.blue{background:rgba(80,190,255,.11);color:#c6f0ff;border-color:rgba(80,190,255,.32)}
button{
  appearance:none;border:0;border-radius:12px;padding:11px 10px;font-weight:1000;font-size:14px;
  background:linear-gradient(180deg,#ffe28a,#e3aa22);color:#190f02;box-shadow:0 5px 0 #825909,0 10px 18px rgba(0,0,0,.26);
}
button:active{transform:translateY(2px);box-shadow:0 3px 0 #825909}
button.dark{background:linear-gradient(180deg,#155b34,#07371f);color:#fff;border:1px solid rgba(245,200,75,.25);box-shadow:0 5px 0 #021007}
button.red{background:linear-gradient(180deg,#cc252b,#8d1014);color:#fff;box-shadow:0 5px 0 #4a080a}
.raceList{background:var(--ivory);border:1px solid var(--gold);border-radius:16px;overflow:hidden;color:var(--ink);margin-top:10px}
.raceListHeader{display:flex;align-items:center;justify-content:space-between;background:#06391f;color:var(--text);padding:11px 12px;font-weight:1000}
.raceRow{display:grid;grid-template-columns:48px 1fr;gap:10px;border-top:1px solid #d1c4a0;background:#fbf5e4;position:relative}
.raceRow:nth-child(odd){background:#f1ead6}
.sourceBand{display:grid;place-items:center;color:#fff;font-weight:1000;background:#065030;writing-mode:vertical-rl;letter-spacing:.08em;font-size:15px}
.sourceBand.local{background:#8d650c}
.raceMain{padding:12px 96px 12px 0;min-height:96px}
.raceNameLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.racePlace{font-size:24px;font-weight:1000;color:#075831}
.racePlace.local{color:#8d650c}
.gradeTag{display:inline-block;background:#08713c;color:#fff;border-radius:7px;padding:3px 7px;font-size:12px;font-weight:1000}
.gradeTag.blue{background:#247aa6}.gradeTag.purple{background:#70419a}
.raceTitle{font-size:17px;font-weight:1000;margin-top:4px}.raceMeta{font-size:12px;color:#5b533f;margin-top:5px}
.raceButtons{position:absolute;right:10px;top:16px;display:flex;flex-direction:column;gap:8px;width:78px}
.raceButtons button{font-size:12px;padding:8px 4px;border-radius:8px;box-shadow:none}
.statusBox{font-size:13px;color:var(--muted);line-height:1.55}
.msg{padding:11px;border-radius:13px;font-size:13px;line-height:1.55;margin:10px 0;border:1px solid rgba(245,200,75,.25)}
.ok{background:rgba(16,77,39,.75);border-color:rgba(33,208,122,.35);color:#dfffea}
.err{background:rgba(70,18,24,.88);border-color:rgba(255,75,85,.4);color:#ffe0e3}
.loader{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.28);border-top-color:var(--gold);border-radius:50%;animation:spin 1s linear infinite;vertical-align:-2px}
@keyframes spin{to{transform:rotate(360deg)}}
.result{display:none}
.judgeGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.judgeItem{background:rgba(255,255,255,.06);border:1px solid rgba(245,200,75,.2);border-radius:12px;padding:9px;font-size:12px;color:var(--muted)}
.judgeItem b{display:block;color:var(--gold2);font-size:14px;margin-bottom:2px}
.rankTable{border:1px solid rgba(245,200,75,.25);border-radius:14px;overflow:hidden;margin-top:12px}
.rankRow{display:grid;grid-template-columns:36px 42px 1fr 54px;gap:8px;align-items:center;border-top:1px solid rgba(245,200,75,.14);padding:10px;background:rgba(0,0,0,.14)}
.rankRow:first-child{border-top:0}
.mark{font-weight:1000;font-size:18px;color:var(--gold2)}
.num{width:34px;height:34px;border-radius:7px;display:grid;place-items:center;background:#e66d18;color:#fff;font-weight:1000}
.num.green{background:#0b753f}.num.black{background:#111}.num.yellow{background:#efc63f;color:#111}.num.white{background:#fff;color:#111}
.horseName{font-weight:1000}.reason{font-size:11px;color:var(--muted);line-height:1.35;margin-top:2px}.score{text-align:right;color:#ff464f;font-weight:1000}
.betSelect{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
.betSelect button{box-shadow:none;background:#f6efdc;color:#140f07;border:1px solid #c8b680}
.betSelect button.active{background:linear-gradient(180deg,#b98416,#815806);color:#fff;border-color:var(--gold)}
.points{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:10px}
.pointBox{background:#f6efdc;color:#140f07;border:1px solid #c8b680;border-radius:12px;padding:10px;text-align:center}
.pointBox label{display:block;font-size:12px;font-weight:1000}.pointBox input{width:100%;border:0;background:transparent;text-align:center;font-size:22px;font-weight:1000;color:#075831;outline:none}
.exactMode{display:inline-flex;align-items:center;gap:6px;margin-top:8px;border:1px solid #99824a;border-radius:999px;padding:5px 10px;background:#f6efdc;color:#140f07;font-size:12px;font-weight:1000}
.ticketGroup{border:1px solid rgba(245,200,75,.35);border-radius:16px;overflow:hidden;margin:12px 0;background:#04180d}
.ticketHead{display:flex;justify-content:space-between;padding:9px 12px;font-weight:1000;color:#130d02}
.ticketHead.honmei{background:#c2ffc8}.ticketHead.ana{background:#ffe29a}.ticketHead.oogana{background:#ff8c96;color:#fff}
.ticketBody{background:#f7efdb;color:#171006;padding:12px;border-top:1px dashed #b7a16c}
.ticketKind{font-size:13px;font-weight:1000;color:#6c5620;margin-bottom:8px}
.ticketLine{font-size:24px;font-weight:1000;letter-spacing:.03em;margin:6px 0}
.ticketSmall{font-size:12px;color:#5e5033;line-height:1.45}
.footer{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin:14px 0 4px}
.footerItem{border:1px solid rgba(245,200,75,.25);border-radius:14px;padding:10px;color:var(--muted);font-size:11px;line-height:1.45}
.footerItem b{display:block;color:var(--gold2);font-size:12px;margin-bottom:3px}
@media(min-width:720px){
  .split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .raceButtons{flex-direction:row;width:auto}
}

/* === V2 iPhone UI readability patch === */
body{background:linear-gradient(180deg,#031108,#061008 38%,#010503)!important}
main{padding:0 10px 38px!important}
.heroTitle{font-size:38px!important;line-height:1.15!important}
.card{border-radius:20px!important;border:1px solid rgba(245,200,75,.55)!important;box-shadow:0 10px 28px rgba(0,0,0,.35)!important}
.raceList{background:#fff5dc!important;border-radius:20px!important;border:2px solid var(--gold)!important}
.raceListHeader{background:linear-gradient(90deg,#03391f,#075831)!important;color:#fff8e8!important;font-size:15px!important}
.raceRow{
  display:grid!important;
  grid-template-columns:44px 1fr!important;
  gap:0!important;
  background:#fff7e4!important;
  border-top:2px solid #dfca83!important;
  min-height:150px!important;
}
.raceRow:nth-child(odd){background:#fff0cc!important}
.sourceBand{
  background:#006837!important;
  color:#fff!important;
  font-size:17px!important;
  font-weight:1000!important;
  text-shadow:0 1px 2px rgba(0,0,0,.35)!important;
}
.sourceBand.local{background:#0b5b31!important;color:#fff!important}
.raceMain{
  padding:13px 12px 14px!important;
  min-height:150px!important;
  color:#121007!important;
}
.raceNameLine{gap:7px!important;margin-bottom:6px!important}
.racePlace,.racePlace.local{
  color:#111!important;
  font-size:27px!important;
  line-height:1.05!important;
  text-shadow:none!important;
}
.gradeTag{font-size:12px!important;border-radius:999px!important;padding:4px 8px!important;background:#075831!important}
.gradeTag.blue{background:#1768a6!important}
.gradeTag.purple{background:#7b1118!important}
.raceTitle{
  color:#111!important;
  font-size:18px!important;
  line-height:1.35!important;
  margin:8px 0 4px!important;
}
.raceMeta{
  color:#2f2a18!important;
  font-size:14px!important;
  line-height:1.45!important;
  font-weight:800!important;
}
.raceButtons{
  position:static!important;
  display:grid!important;
  grid-template-columns:1fr 1fr!important;
  gap:10px!important;
  width:100%!important;
  margin-top:12px!important;
}
.raceButtons button{
  font-size:15px!important;
  padding:12px 8px!important;
  border-radius:13px!important;
  min-height:46px!important;
  box-shadow:0 4px 0 rgba(0,0,0,.25)!important;
}
.raceButtons button.red{
  background:linear-gradient(180deg,#d8202b,#8d1018)!important;
  color:#fff!important;
}
.raceButtons button.dark{
  background:linear-gradient(180deg,#222,#050505)!important;
  color:#fff!important;
}
.cta{border-radius:18px!important;min-height:88px!important}
.ctaMain{font-size:18px!important}
.pill{font-size:13px!important;padding:8px 10px!important}
.sectionTitle{font-size:24px!important;color:var(--gold2)!important}
.sectionSub{font-size:13px!important;line-height:1.45!important}
.betSelect button{font-size:13px!important;min-height:44px!important}
.rankRow{grid-template-columns:34px 40px 1fr 48px!important}
.ticketLine{font-size:22px!important}
@media(max-width:430px){
  .dataPanel{position:relative!important;right:auto!important;top:auto!important;width:100%!important;margin:12px 0!important}
  .heroInner{min-height:360px!important}
  .heroTitle{font-size:34px!important}
}

</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="logo">${appIconSvg()}</div>
    <div>
      <h1>${APP_NAME}</h1>
      <div class="brandSub">JRA + 地方競馬　中央＋地方 / iPhone対応</div>
    </div>
    <div class="headerRight">
      <div class="updateMini">データ更新<br><span id="updateTime">--:--</span></div>
      <div class="menuIcon"><span></span><span></span><span></span></div>
    </div>
  </div>
</header>

<main>
  <section class="hero">
    ${horseHeroSvg()}
    <div class="heroShade"></div>
    <div class="heroInner">
      <div class="copy">勝つための情報を、<br>すべてこの一画面に。</div>
      <div class="heroTitle">明日のレースを<br>AIが完全予想</div>
      <div class="dataPanel">
        <div class="dataPanelTitle">データ更新状況</div>
        <div class="dataRow"><span>出馬表</span><b id="stEntries">取得中</b></div>
        <div class="dataRow"><span>オッズ</span><b id="stOdds">確認中</b></div>
        <div class="dataRow"><span>馬場</span><b id="stGround">確認中</b></div>
        <div class="dataRow"><span>馬体重</span><b id="stWeight">発表待ち</b></div>
      </div>
      <div class="ctas">
        <div class="cta red" onclick="loadRaces(1)">
          <div class="ctaIcon">♞</div><div><div class="ctaMain">明日のレース</div><div class="ctaSub">レースごとにボタンで予想</div></div>
        </div>
        <div class="cta green" onclick="loadRaces(0)">
          <div class="ctaIcon">♞</div><div><div class="ctaMain">今日のレース</div><div class="ctaSub">今日の出馬表を取得</div></div>
        </div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="sectionHead">
      <div>
        <div class="sectionTitle">レース一覧</div>
        <div class="sectionSub" id="topStatus">読み込み中…</div>
      </div>
      <button class="dark" onclick="loadRaces(currentOffset)">再取得</button>
    </div>
    <div class="pills" id="venuePills"></div>
    <div class="raceList" id="races">
      <div class="raceListHeader"><span>レース一覧</span><span>自動更新</span></div>
    </div>
  </section>

  <section id="result" class="card result">
    <div class="sectionHead">
      <div>
        <div class="sectionTitle" id="resultTitle">AI予想結果</div>
        <div class="sectionSub" id="resultSub"></div>
      </div>
      <button class="dark" onclick="copyCurrent()">コピー</button>
    </div>
    <div id="resultStatus"></div>
    <div id="judgement"></div>
    <div id="ranking"></div>

    <div class="split">
      <div class="card" style="margin:12px 0">
        <div class="sectionTitle">券種選択</div>
        <div class="betSelect" id="betSelect"></div>
      </div>

      <div class="card" style="margin:12px 0">
        <div class="sectionTitle">点数設定</div>
        <div class="points" id="pointInputs"></div>
        <div class="exactMode">🔒 点数厳密モード</div>
        <button style="margin-top:10px;width:100%" onclick="savePoints()">点数保存</button>
      </div>
    </div>

    <div id="tickets"></div>
  </section>

  <section class="footer">
    <div class="footerItem"><b>データソース</b>JRA公式 / 地方競馬公式</div>
    <div class="footerItem"><b>自動更新</b>出馬表・オッズ・成績を取得</div>
    <div class="footerItem"><b>精度管理</b>不足時は予想保留</div>
  </section>
</main>

<script>
const DEFAULT_POINTS = ${JSON.stringify(DEFAULT_POINTS)};
const BET_LABELS = ${JSON.stringify(BET_LABELS)};
let currentOffset = 1;
let currentRace = null;
let currentPrediction = null;
let selectedBet = "sanrentan";
let currentPlain = "";

function esc(s){return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));}
async function api(path){
  const r = await fetch(path,{cache:"no-store"});
  const j = await r.json();
  if(!j.ok) throw new Error(j.error || "取得失敗");
  return j;
}
function nowLabel(){
  const d = new Date();
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
function loadPointSettings(){
  try{
    const saved = JSON.parse(localStorage.getItem("renKeibaPoints") || "{}");
    return {...DEFAULT_POINTS, ...saved};
  }catch(e){return DEFAULT_POINTS;}
}
function savePointSettings(settings){
  localStorage.setItem("renKeibaPoints", JSON.stringify(settings));
}
let pointSettings = loadPointSettings();

async function loadRaces(offset=1){
  currentOffset = offset;
  document.getElementById("topStatus").innerHTML = '<span class="loader"></span> 公式レース一覧を取得中…';
  document.getElementById("venuePills").innerHTML = "";
  document.getElementById("races").innerHTML = '<div class="raceListHeader"><span>レース一覧</span><span>自動更新</span></div>';
  document.getElementById("updateTime").textContent = nowLabel();
  try{
    const data = await api("/api/races?offset="+offset);
    const races = data.races || [];
    document.getElementById("topStatus").textContent = data.date + " / " + races.length + "レース";
    document.getElementById("stEntries").textContent = races.length ? "取得済み" : "不足";
    document.getElementById("stOdds").textContent = "予想時取得";
    document.getElementById("stGround").textContent = "予想時判定";
    document.getElementById("stWeight").textContent = "発表後反映";
    const venues = [...new Map(races.map(r=>[(r.sourceLabel||"")+"-"+r.place,r])).values()];
    document.getElementById("venuePills").innerHTML =
      venues.map(v=>'<span class="pill '+(v.source==="jra"?"blue":"green")+'">'+esc(v.sourceLabel)+" "+esc(v.place)+'</span>').join("") +
      '<span class="pill">合計 '+races.length+'R</span>';
    renderRaces(races);
  }catch(e){
    document.getElementById("topStatus").innerHTML = '<span class="err msg">'+esc(e.message)+'</span>';
  }
}

function renderRaces(races){
  const box = document.getElementById("races");
  let html = '<div class="raceListHeader"><span>レース一覧</span><span>自動更新</span></div>';
  if(!races.length){
    html += '<div class="raceRow"><div class="sourceBand">--</div><div class="raceMain">レースが見つかりませんでした。</div></div>';
    box.innerHTML = html;
    return;
  }
  for(const r of races){
    const local = r.source !== "jra";
    const gradeCls = r.source === "jra" ? "blue" : "purple";
    const grade = r.source === "jra" ? "JRA" : "地方";
    html += \`
      <div class="raceRow">
        <div class="sourceBand \${local?'local':''}">\${esc(r.sourceLabel || (local?'地方':'中央'))}</div>
        <div class="raceMain">
          <div class="raceNameLine">
            <span class="racePlace \${local?'local':''}">\${esc(r.place)} \${r.r}R</span>
            <span class="gradeTag \${gradeCls}">\${grade}</span>
          </div>
          <div class="raceTitle">\${esc(r.name)}</div>
          <div class="raceMeta">◷ \${esc(r.time || "時刻未取得")}　|　\${esc(r.course || (r.source==="jra"?"JRA":"距離未取得"))}\${r.heads? "　|　"+r.heads+"頭":""}</div>
          <div class="raceButtons">
            <button class="red" onclick='predict(\${JSON.stringify(r)})'>このレースをAI予想</button>
            <button class="dark" onclick='window.open("\${esc(r.officialUrl)}","_blank")'>公式出馬表</button>
          </div>
        </div>
      </div>\`;
  }
  box.innerHTML = html;
}

async function predict(r){
  currentRace = r;
  currentPrediction = null;
  document.getElementById("result").style.display = "block";
  document.getElementById("resultTitle").textContent = (r.sourceLabel || "")+" "+r.place+" "+r.r+"R";
  document.getElementById("resultSub").textContent = r.name + " / " + (r.course || "");
  document.getElementById("resultStatus").innerHTML = '<div class="msg ok"><span class="loader"></span> 出馬表・オッズ・過去成績・血統要素を解析中…</div>';
  document.getElementById("judgement").innerHTML = "";
  document.getElementById("ranking").innerHTML = "";
  document.getElementById("tickets").innerHTML = "";
  location.hash = "result";
  try{
    const q = "/api/predict?source="+encodeURIComponent(r.source||"nar")+
      "&code="+encodeURIComponent(r.code)+
      "&date="+encodeURIComponent(r.date)+
      "&race="+encodeURIComponent(r.r)+
      "&kai="+encodeURIComponent(r.kai||0)+
      "&day="+encodeURIComponent(r.day||0);
    const data = await api(q);
    currentPrediction = data.prediction;
    renderPrediction(data.prediction, r);
  }catch(e){
    document.getElementById("resultStatus").innerHTML = '<div class="msg err">'+esc(e.message)+'</div>';
  }
}

function renderPrediction(p, r){
  if(!p || p.status === "hold"){
    const reasons = p?.quality?.reasons || ["データ不足"];
    document.getElementById("resultStatus").innerHTML = '<div class="msg err"><b>精度不足：予想保留</b><br>'+reasons.map(esc).join("<br>")+'</div>';
    document.getElementById("stEntries").textContent = p?.quality?.status?.entries || "不足";
    document.getElementById("stOdds").textContent = p?.quality?.status?.odds || "不足";
    document.getElementById("stWeight").textContent = p?.quality?.status?.weight || "発表待ち";
    return;
  }

  document.getElementById("stEntries").textContent = p.quality.status.entries;
  document.getElementById("stOdds").textContent = p.quality.status.odds;
  document.getElementById("stWeight").textContent = p.quality.status.weight;
  document.getElementById("stGround").textContent = "判定済み";

  document.getElementById("resultStatus").innerHTML = '<div class="msg ok">AI予想完了。データ不足時は自動で予想保留にします。</div>';

  const j = p.judgement;
  document.getElementById("judgement").innerHTML = \`
    <div class="card" style="margin:12px 0">
      <div class="sectionTitle">AIレース判定</div>
      <div class="judgeGrid">
        <div class="judgeItem"><b>荒れ度</b>\${esc(j.roughLabel)} / \${j.rough}</div>
        <div class="judgeItem"><b>軸信頼度</b>\${esc(j.axis)}</div>
        <div class="judgeItem"><b>展開</b>\${esc(j.pace)}</div>
        <div class="judgeItem"><b>馬場/コース</b>\${esc(j.bias)}</div>
        <div class="judgeItem"><b>おすすめ券種</b>\${j.recommended.map(esc).join("・")}</div>
        <div class="judgeItem"><b>穴で拾う馬</b>\${j.hole.length?j.hole.map(esc).join(" / "):"該当少なめ"}</div>
      </div>
    </div>\`;

  const mark = ["◎","○","▲","△","☆"];
  const colors = ["","green","black","yellow","white"];
  document.getElementById("ranking").innerHTML =
    '<div class="rankTable">'+
    p.horses.slice(0,10).map((h,i)=>\`
      <div class="rankRow">
        <div class="mark">\${mark[i] || "・"}</div>
        <div class="num \${colors[i] || ""}">\${h.no}</div>
        <div>
          <div class="horseName">\${esc(h.name)}</div>
          <div class="reason">\${esc(h.reason)}</div>
        </div>
        <div class="score">\${h.score}</div>
      </div>\`).join("")+
    '</div>';

  renderBetSelect();
  renderPointInputs();
  renderTickets();
  makePlainText();
}

function renderBetSelect(){
  const types = ["all","tan","fuku","wide","umaren","umatan","sanrenpuku","sanrentan"];
  document.getElementById("betSelect").innerHTML = types.map(t =>
    '<button class="'+(selectedBet===t?'active':'')+'" onclick="selectBet(\\''+t+'\\')">'+BET_LABELS[t]+'</button>'
  ).join("");
}

function selectBet(t){
  selectedBet = t;
  renderBetSelect();
  renderPointInputs();
  renderTickets();
}

function renderPointInputs(){
  const types = selectedBet === "all" ? Object.keys(DEFAULT_POINTS) : [selectedBet];
  const t = selectedBet === "all" ? "sanrentan" : selectedBet;
  const p = pointSettings[t] || DEFAULT_POINTS[t];
  document.getElementById("pointInputs").innerHTML = \`
    <div class="pointBox"><label>本命</label><input id="ptHonmei" type="number" min="0" value="\${p.honmei}"><span>点</span></div>
    <div class="pointBox"><label>穴</label><input id="ptAna" type="number" min="0" value="\${p.ana}"><span>点</span></div>
    <div class="pointBox"><label>大穴</label><input id="ptOogana" type="number" min="0" value="\${p.oogana}"><span>点</span></div>
  \`;
}

function savePoints(){
  const t = selectedBet === "all" ? "sanrentan" : selectedBet;
  pointSettings[t] = {
    honmei:Number(document.getElementById("ptHonmei").value||0),
    ana:Number(document.getElementById("ptAna").value||0),
    oogana:Number(document.getElementById("ptOogana").value||0),
  };
  savePointSettings(pointSettings);
  alert("点数を保存しました");
}

function renderCompressed(c){
  if(!c || !c.length) return "";
  return c.map(x=>{
    if(x.kind === "流し") return '<div class="ticketKind">買い方：流し</div><div class="ticketLine">軸：'+x.axis.join(",")+'</div><div class="ticketSmall">相手：'+x.opponents.join(", ")+'</div>';
    if(x.kind === "1着固定流し") return '<div class="ticketKind">買い方：1着固定流し</div><div class="ticketLine">1着：'+x.first.join(",")+'</div><div class="ticketSmall">2着：'+x.second.join(", ")+'</div>';
    if(x.kind === "フォーメーション") return '<div class="ticketKind">買い方：フォーメーション</div><div class="ticketLine">1着：'+x.first.join(",")+'</div><div class="ticketSmall">2着：'+x.second.join(", ")+'<br>3着：'+x.third.join(", ")+'</div>';
    if(x.kind === "軸1頭流し") return '<div class="ticketKind">買い方：軸1頭流し</div><div class="ticketLine">軸：'+x.axis.join(",")+'</div><div class="ticketSmall">相手：'+x.opponents.join(", ")+'</div>';
    return '<div class="ticketKind">買い方：個別指定</div>'+x.lines.map(k=>'<div class="ticketLine">'+esc(k)+'</div>').join("");
  }).join("");
}

function ticketGroupHtml(groupKey, g){
  const cls = groupKey === "honmei" ? "honmei" : groupKey === "ana" ? "ana" : "oogana";
  return \`
    <div class="ticketGroup">
      <div class="ticketHead \${cls}"><span>\${esc(g.label)} / \${esc(g.sub)}</span><span>\${g.count}点</span></div>
      <div class="ticketBody">
        \${renderCompressed(g.compressed)}
        <div class="ticketSmall" style="margin-top:8px">合計：\${g.tickets.length}点ぴったり / 余計な買い目は追加しません</div>
      </div>
    </div>\`;
}

function renderTickets(){
  if(!currentPrediction || currentPrediction.status !== "ok") return;
  const p = currentPrediction;
  let html = '<div class="sectionTitle" style="margin-top:12px">買い目</div>';

  if(selectedBet === "all"){
    for(const t of ["wide","umaren","sanrenpuku","sanrentan"]){
      html += '<div class="card"><div class="sectionTitle">'+BET_LABELS[t]+'</div>';
      const data = p.tickets[t];
      html += ticketGroupHtml("honmei", data.honmei);
      html += ticketGroupHtml("ana", data.ana);
      html += ticketGroupHtml("oogana", data.oogana);
      html += '</div>';
    }
  }else{
    html += '<div class="card"><div class="sectionTitle">'+BET_LABELS[selectedBet]+'</div>';
    const data = p.tickets[selectedBet];
    html += ticketGroupHtml("honmei", data.honmei);
    html += ticketGroupHtml("ana", data.ana);
    html += ticketGroupHtml("oogana", data.oogana);
    html += '</div>';
  }

  document.getElementById("tickets").innerHTML = html;
}

function makePlainText(){
  if(!currentPrediction || currentPrediction.status !== "ok" || !currentRace) return;
  const h = currentPrediction.horses.slice(0,8).map((x,i)=>\`\${["◎","○","▲","△","☆"][i]||"・"} \${x.no} \${x.name} 指数\${x.score}\`).join("\\n");
  currentPlain = \`\${APP_NAME}\\n\${currentRace.place} \${currentRace.r}R \${currentRace.name}\\n\\n\${h}\`;
}
async function copyCurrent(){
  if(!currentPlain) return alert("先にAI予想を出してください");
  await navigator.clipboard.writeText(currentPlain);
  alert("コピーしました");
}

loadRaces(1);
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/manifest.json") {
      return new Response(manifestJson(), {
        headers: { "content-type": "application/manifest+json; charset=utf-8" }
      });
    }

    if (url.pathname === "/icon.svg") {
      return svg(appIconSvg());
    }

    if (url.pathname === "/api/races") {
      const offset = Number(url.searchParams.get("offset") || "1");
      const date = url.searchParams.get("date") || jstDate(offset);
      try {
        const races = await getRaces(date);
        return json({ ok:true, date, races });
      } catch (e) {
        return json({ ok:false, error:e.message }, 500);
      }
    }

    if (url.pathname === "/api/predict") {
      const source = url.searchParams.get("source") || "nar";
      const code = url.searchParams.get("code");
      const date = url.searchParams.get("date") || jstDate(1);
      const race = Number(url.searchParams.get("race") || "1");
      const kai = Number(url.searchParams.get("kai") || "0");
      const day = Number(url.searchParams.get("day") || "0");

      if (!code || !race) return json({ ok:false, error:"code/raceが足りません" }, 400);

      try {
        const prediction = source === "jra"
          ? await predictJraRace(code, date, race, kai, day)
          : await predictNarRace(code, date, race);
        return json({ ok:true, source, date, code, race, prediction });
      } catch (e) {
        return json({ ok:false, error:e.message }, 500);
      }
    }

    return page(appHtml());
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(getRaces(jstDate(1)).catch(()=>null));
  }
};
