/* ============================================================================
 * סימולציה דגלי דוד — לוגיקת הדאשבורד (ניתוח מונים + אגירה)
 * נתונים: window.METER_DATA (מערכים מקבילים ברשת 15-דק'), window.TARIFF
 * צבעים/פונטים: נמשכים מ-theme.css (מקור עיצובי יחיד — enSights)
 * ========================================================================== */
(function () {
  "use strict";
  // צבע/טוקן מ-theme.css (מקור יחיד)
  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  Chart.defaults.animation = false;          // ביצועים: ללא אנימציה בעדכונים
  Chart.defaults.font.family = cv("--font") || "Arial, sans-serif";
  Chart.defaults.color = cv("--muted");

  // רקע הגרף לפי תקופת תעו״ז: אדום=פסגה, ירוק=שפל (רק כשציר-ה-X הוא שעת-יום)
  Chart.register({
    id: "tariffBg",
    beforeDraw(chart) {
      const cfg = chart.options.plugins && chart.options.plugins.tariffBg;
      if (!cfg || !cfg.bands || !cfg.bands.length) return;
      const { ctx, chartArea: ca, scales: { x } } = chart;
      const bands = cfg.bands, out = cfg.outageBands, n = bands.length;
      const step = n > 1 ? (x.getPixelForValue(1) - x.getPixelForValue(0)) : (ca.right - ca.left);
      ctx.save();
      for (let i = 0; i < n; i++) {
        const b = bands[i];
        const isOut = out && out[i];
        if (b == null && !isOut) continue;
        const c = x.getPixelForValue(i);
        let left = Math.max(ca.left, c - step / 2), right = Math.min(ca.right, c + step / 2);
        if (right <= left) continue;
        ctx.fillStyle = isOut ? cfg.outageColor : (b ? cfg.peakColor : cfg.offColor);   // הפסקה גוברת
        ctx.fillRect(left, ca.top, right - left, ca.bottom - ca.top);
      }
      ctx.restore();
    },
  });

  const D = window.METER_DATA, T = window.TARIFF;
  const N = D.meta.n, STEP_MIN = D.meta.stepMinutes;      // 15
  const SLOT_H = STEP_MIN / 60;                            // 0.25 שעה לסלוט

  // בסיס זמן ב-UTC כדי לייצג "שעון קיר" ללא תלות ב-DST של המחשב
  const bp = D.meta.start.split(/[-T:]/).map(Number);      // [Y,M,D,h,m]
  const BASE = Date.UTC(bp[0], bp[1] - 1, bp[2], bp[3], bp[4]);
  const slotMs = STEP_MIN * 60000;

  // ---- סדרות גולמיות + נגזרות (per-slot) ----
  // ימי חוסר-נתונים (מונה דו-כיווני לא דיווח): הסדרות התלויות ביבוא/יצוא מסומנות NaN
  // כדי שלא יצוירו כ"עומס" סולארי מטעה. מונה ה-PV אמיתי ולכן נשמר.
  const GAP = new Set(D.meta.gapDays || []);
  const pv = D.pv, cons = D.cons, imp = D.imp, exp = D.exp;
  const self = new Float32Array(N), load = new Float32Array(N), bidir = new Float32Array(N);
  const slotDate = new Array(N);       // אובייקט Date (UTC=שעון קיר) לכל סלוט
  const slotTar = new Array(N);        // סיווג תעו״ז לכל סלוט
  for (let i = 0; i < N; i++) {
    if (GAP.has((i / 96) | 0)) {
      imp[i] = exp[i] = cons[i] = NaN;              // חוסר נתונים — לא לצייר
      self[i] = load[i] = bidir[i] = NaN;
    } else {
      self[i] = Math.max(0, (pv[i] || 0) - (exp[i] || 0));
      load[i] = Math.max(0, (imp[i] || 0) + (pv[i] || 0) - (exp[i] || 0));
      bidir[i] = (imp[i] || 0) - (exp[i] || 0);     // נטו על המונה הדו-כיווני
    }
    const t = new Date(BASE + i * slotMs);
    slotDate[i] = t;
    const ds = t.toISOString().slice(0, 10);
    slotTar[i] = T.classify(ds, t.getUTCDay(), t.getUTCMonth() + 1, t.getUTCHours());
  }
  // מערכי אגירה (מחושבים ע"י simulateStorage) — נכללים באגרגציה
  const charge = new Float32Array(N), discharge = new Float32Array(N), soc = new Float32Array(N);
  const impBat = new Float32Array(N);   // יבוא מהרשת אחרי הוספת אגירה = imp + charge - discharge
  const SERIES_ARR = { pv, imp, exp, self, load, cons, bidir, charge, discharge, soc, impBat };

  // ---- הגדרת סדרות לתצוגה (צבעים מ-theme.css) ----
  // "יבוא מהרשת" מציג את המציאות: impBat = יבוא + טעינה − פריקה. כשאין אגירה impBat==imp.
  // הבסיס ההיסטורי (imp הגולמי) זמין כסדרת השוואה "יבוא — בלי אגירה", כבויה כברירת מחדל.
  const SERIES = [
    { id: "load",      name: "סך עומס",              color: cv("--s-load"),      on: true },
    { id: "self",      name: "צריכה עצמית",           color: cv("--s-self"),      on: true },
    { id: "discharge", name: "פריקה מאגירה",          color: cv("--s-discharge"), on: true },
    { id: "impBat",    name: "יבוא מהרשת",            color: cv("--s-imp"),       on: false },
    { id: "pv",        name: "ייצור PV",              color: cv("--s-pv"),        on: false },
    { id: "exp",       name: "יצוא לרשת",             color: cv("--s-exp"),       on: false },
    { id: "cons",      name: "מונה צריכה",            color: cv("--s-cons"),      on: false },
    { id: "charge",    name: "טעינת אגירה",           color: cv("--s-charge"),    on: false },
    { id: "imp",       name: "יבוא — בלי אגירה (בסיס)", color: cv("--s-cons"),     on: false, dash: true },
  ];

  // ---- מצב ----
  // מודל "תצוגת תקופה": בוחרים תקופה (יום/שבוע/חודש/שנה/רב-שנתי) ומנווטים בין תקופות.
  // כל תקופה מפורקת לתת-יחידות טבעיות (res): יום→רבע-שעה/שעה, שבוע/חודש→יום, שנה→חודש, רב-שנתי→שנה.
  const state = {
    view: "month",          // day | week | month | year | multi
    dayGran: "q",           // q | hour   (רק בתצוגת יום)
    metric: "kwh",          // kwh | kwavg | kwpeak
    chartType: "bar",       // bar | line  (עמודות = מוערם עם עומס כהשלמה)
    costQty: "load",
    tariffUnit: "kwh",      // kwh | ils
    vat: "vat",             // vat | novat
    anchor: null,           // Date (UTC חצות) המייצג את התקופה הנוכחית
    season: 1,              // עונה לתצוגת "יום ממוצע עונתי": 0=אביב 1=קיץ 2=סתיו 3=חורף
    res: "day", rStart: 0, rEnd: N - 1,   // נגזרים מ-view+anchor
    bat: { cab: 1, cap: 261, ac: 125, socMax: 95, socMin: 20, eff: 90, smart: true, maxCycles: 6000, calLife: 15 },  // אגירה
    cost: { perKwh: 190, fixed: 25000 },  // עלות התקנה: ₪/kWh + קבוע
  };
  // בתצוגת עמודות: "סך עומס" מצויר כהשלמה מעל רכיבי-העומס המוצגים (צריכה עצמית / פריקה),
  // כך שהעמודה תמיד מגיעה לגובה סך העומס. הסתרת רכיב → העומס תופס את מקומו (עד Y=0).
  const LOAD_COMP = ["self", "discharge"];
  // 4 עונות מטאורולוגיות (לתצוגה העונתית)
  const SEASON4 = ["אביב", "קיץ", "סתיו", "חורף"];
  const season4of = m => (m >= 3 && m <= 5) ? 0 : (m >= 6 && m <= 8) ? 1 : (m >= 9 && m <= 11) ? 2 : 3;
  const slotSeason = new Uint8Array(N);
  for (let i = 0; i < N; i++) slotSeason[i] = season4of(slotDate[i].getUTCMonth() + 1);

  // ---- זיהוי הפסקות חשמל: כל המונים = 0 (אין זרימת אנרגיה כלל), לא ביום חוסר-נתונים ----
  // (load==0 לבדו נותן שגויים בצהריים בגלל ארטיפקט יצוא>ייצור; לכן דורשים imp=pv=exp=0)
  const isOutage = new Uint8Array(N);
  const OUTAGES = [];   // [{s,e}] אינדקסי סלוט התחלה/סוף (כולל)
  {
    let cur = null;
    for (let i = 0; i < N; i++) {
      const gap = GAP.has((i / 96) | 0);
      const outage = !gap && (imp[i] || 0) === 0 && (pv[i] || 0) === 0 && (exp[i] || 0) === 0;
      isOutage[i] = outage ? 1 : 0;
      if (outage) { if (!cur) cur = { s: i, e: i }; else cur.e = i; }
      else if (cur) { OUTAGES.push(cur); cur = null; }
    }
    if (cur) OUTAGES.push(cur);
  }
  const VIEW_RES = { day: () => state.dayGran, week: () => "day", month: () => "day", year: () => "month", multi: () => "year",
                     avgMonth: () => state.dayGran, avgSeason: () => state.dayGran };
  const isAvgView = () => state.view === "avgMonth" || state.view === "avgSeason";
  const HE_DOW = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  const FIRST_DAY = new Date(Date.UTC(slotDate[0].getUTCFullYear(), slotDate[0].getUTCMonth(), slotDate[0].getUTCDate()));
  const LAST_DAY = new Date(Date.UTC(slotDate[N-1].getUTCFullYear(), slotDate[N-1].getUTCMonth(), slotDate[N-1].getUTCDate()));

  // ============================ עזרי זמן =====================================
  const HE_MON = ["ינו","פבר","מרץ","אפר","מאי","יונ","יול","אוג","ספט","אוק","נוב","דצמ"];
  const pad = n => String(n).padStart(2, "0");
  function isoWeekKeySunday(t) {
    // שבוע שמתחיל בראשון
    const d = new Date(t.getTime());
    const dow = d.getUTCDay();               // 0=ראשון
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  function bucketOf(i) {
    const t = slotDate[i];
    const Y = t.getUTCFullYear(), Mo = t.getUTCMonth(), Da = t.getUTCDate(), H = t.getUTCHours(), Mi = t.getUTCMinutes();
    // תצוגות "יום ממוצע": קיבוץ לפי שעת-היום (מוצע על פני הימים)
    if (isAvgView()) {
      if (state.res === "hour") return { key: `${pad(H)}`, label: `${pad(H)}:00`, hours: 1, tod: H };
      return { key: `${pad(H)}:${pad(Mi)}`, label: `${pad(H)}:${pad(Mi)}`, hours: SLOT_H, tod: H * 4 + Mi / 15 };
    }
    switch (state.res) {
      case "q":     return { key: i, label: `${pad(H)}:${pad(Mi)}`, hours: SLOT_H };
      case "hour":  return { key: `${Y}-${pad(Mo)}-${pad(Da)}-${pad(H)}`, label: `${pad(H)}:00`, hours: 1 };
      case "day":   return { key: `${Y}-${pad(Mo)}-${pad(Da)}`, label: `${pad(Da)}/${pad(Mo+1)}`, hours: 24 };
      case "week":  { const wk = isoWeekKeySunday(t); const d = new Date(wk+"T00:00:00Z"); return { key: wk, label: `${pad(d.getUTCDate())}/${pad(d.getUTCMonth()+1)}`, hours: 168 }; }
      case "month": return { key: `${Y}-${pad(Mo)}`, label: `${HE_MON[Mo]} ${String(Y).slice(2)}`, hours: 0 };
      case "year":  return { key: `${Y}`, label: `${Y}`, hours: 0 };
      case "multi": return { key: "all", label: "כל התקופה", hours: 0 };
    }
  }

  // ============================ אגרגציה ======================================
  // טווח הסלוטים בתוקף כרגע. בתצוגה עונתית — כל הנתונים מסוננים לפי העונה הנבחרת.
  function scope() {
    if (state.view === "avgSeason") return { a: 0, b: N - 1, ok: i => slotSeason[i] === state.season };
    return { a: Math.max(0, state.rStart), b: Math.min(N - 1, state.rEnd), ok: null };
  }
  function aggregate() {
    const order = [], map = new Map();
    const sc = scope(), a = sc.a, b = sc.b;
    for (let i = a; i <= b; i++) {
      if (sc.ok && !sc.ok(i)) continue;
      const bk = bucketOf(i);
      let o = map.get(bk.key);
      if (!o) {
        o = { label: bk.label, hours: 0, n: 0, vals: {}, peak: {}, cnt: {}, tar: {}, peakN: 0, offN: 0, outN: 0 };
        for (const s of SERIES) { o.vals[s.id] = 0; o.peak[s.id] = 0; o.cnt[s.id] = 0; }
        map.set(bk.key, o); order.push(bk.key);
      }
      o.n++; o.hours += SLOT_H;
      if (slotTar[i].per === "פסגה") o.peakN++; else o.offN++;
      if (isOutage[i]) o.outN++;
      for (const s of SERIES) {
        const v = SERIES_ARR[s.id][i];
        if (!Number.isFinite(v)) continue;     // סלוט חוסר-נתונים — מדלגים
        o.vals[s.id] += v; o.cnt[s.id]++;
        const pw = v / SLOT_H;                 // הספק רגעי (kW) של הסלוט
        if (pw > o.peak[s.id]) o.peak[s.id] = pw;
      }
      // פילוח תעו״ז — על הכמות הנבחרת לחיוב
      const q = SERIES_ARR[state.costQty][i];
      if (Number.isFinite(q)) {
        const tk = slotTar[i].key;
        o.tar[tk] = (o.tar[tk] || 0) + q;
      }
    }
    return { order, map, a, b };
  }

  // ============================ סימולציית אגירה ==============================
  // מודל ארביטראז' יומי: פורק בשעות פסגה כדי לקזז יבוא (בלי יצוא לרשת),
  // וטוען בשעות שפל (עדיפות לפני הפסגה). מחשב charge[], discharge[], soc[].
  function fillImpBat() {
    for (let i = 0; i < N; i++)
      impBat[i] = Number.isFinite(imp[i]) ? Math.max(0, imp[i] + (charge[i] || 0) - (discharge[i] || 0)) : NaN;
  }
  function simulateStorage() {
    const b = state.bat;
    charge.fill(0); discharge.fill(0); soc.fill(0);
    const capTot = b.cab * b.cap;                          // kWh כולל
    const usable = capTot * (b.socMax - b.socMin) / 100;   // kWh שמיש
    const pMax15 = b.cab * b.ac * SLOT_H;                  // kWh לרבע-שעה בהספק AC מלא
    const eff = Math.max(0.01, b.eff / 100);
    const socMinK = capTot * b.socMin / 100;
    if (capTot <= 0 || usable <= 0 || pMax15 <= 0) { fillImpBat(); return; }
    const days = Math.floor(N / 96);
    for (let d = 0; d < days; d++) {
      const s0 = d * 96, s1 = s0 + 95;
      // אגירה חכמה: לחזור רק כשהארביטראז' כדאי (פסגה×נצילות > שפל).
      // בעונות מעבר המרווח זעום ומחזור מפסיד — עדיף להשבית ולחסוך בבלאי.
      if (b.smart) {
        let peakP = 0, offP = 0;
        for (let i = s0; i <= s1; i++) {
          if (slotTar[i].per === "פסגה") peakP = slotTar[i].priceVat;
          else offP = slotTar[i].priceVat;
        }
        if (!(peakP * eff > offP)) continue;   // לא כדאי — הסוללה במנוחה היום
      }
      // פריקה בפסגה: מקזז יבוא, מוגבל בהספק, בקיבולת שמישה
      let Edis = 0;
      for (let i = s0; i <= s1 && Edis < usable; i++) {
        if (slotTar[i].per !== "פסגה") continue;          // פריקה רק בפסגה
        const impV = imp[i] > 0 ? imp[i] : 0;              // 0 כשאין יבוא/חוסר-נתונים
        const loadV = load[i] > 0 ? load[i] : impV;
        // פריקה ≤ עומס וגם ≤ יבוא (=עומס−PV) → מקבילה לעומס ולא פולטת אנרגיה אגורה לרשת
        const dd = Math.min(impV, loadV, pMax15, usable - Edis);
        if (dd > 0) { discharge[i] = dd; Edis += dd; }
      }
      if (Edis <= 0) continue;
      // טעינה בשפל (עדיפות לפני הפריקה הראשונה), כמות = Edis/נצילות
      let firstDis = s1 + 1;
      for (let i = s0; i <= s1; i++) if (discharge[i] > 0) { firstDis = i; break; }
      const Echg = Edis / eff; let done = 0;
      for (let pass = 0; pass < 2 && done < Echg - 1e-6; pass++) {
        for (let i = s0; i <= s1 && done < Echg - 1e-6; i++) {
          if (slotTar[i].per !== "שפל") continue;
          if (pass === 0 && i >= firstDis) continue;   // מעבר 1: רק לפני הפריקה
          if (pass === 1 && i < firstDis) continue;    // מעבר 2: אחרי (נדיר)
          const c = Math.min(pMax15 - charge[i], Echg - done);
          if (c > 0) { charge[i] += c; done += c; }
        }
      }
      // שחזור SOC כרונולוגי
      let socK = socMinK;
      for (let i = s0; i <= s1; i++) {
        socK += (charge[i] || 0) * eff - (discharge[i] || 0);
        soc[i] = capTot > 0 ? (socK / capTot) * 100 : 0;
      }
    }
    fillImpBat();
  }

  // ערך סדרה לפי המדד הנבחר. NaN כשאין דגימות תקפות בבאקט (חוסר נתונים → פער בגרף).
  function metricVal(o, id) {
    const c = o.cnt ? o.cnt[id] : o.n;
    if (!c) return NaN;
    // תצוגות "יום ממוצע": כל באקט = שעת-יום; מציגים ממוצע על פני הימים (vals/מספר-ימים).
    if (isAvgView()) {
      const perSlot = o.vals[id] / c;                // ממוצע אנרגיה בשעת-היום הזו
      return state.metric === "kwh" ? perSlot : perSlot / SLOT_H;   // kWh או kW
    }
    if (state.metric === "kwh") return o.vals[id];
    if (state.metric === "kwpeak") return o.peak[id];
    return o.vals[id] / (c * SLOT_H);                // kwavg — הספק ממוצע
  }

  // ============================ פורמט ========================================
  const nf0 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum = v => Math.abs(v) >= 1000 ? nf0.format(v) : nf1.format(v);
  const fmtILS = v => "₪" + nf0.format(v);
  function metricUnit() { return state.metric === "kwh" ? "kWh" : "kW"; }

  // ============================ צ'ארטים ======================================
  let flowChart, tariffChart;

  function renderFlow(agg) {
    const labels = agg.order.map(k => agg.map.get(k).label);
    const unit = metricUnit();
    const arr = id => agg.order.map(k => { const v = metricVal(agg.map.get(k), id); return Number.isFinite(v) ? +v.toFixed(3) : NaN; });
    let datasets, chartKind, stackedOpt;
    if (state.chartType === "line") {
      // קו — שכבות חופפות (לא מוערם)
      datasets = SERIES.filter(s => s.on).map(s => ({
        label: s.name, data: arr(s.id), borderColor: s.color, backgroundColor: s.color + "22",
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .18, fill: false, borderDash: s.dash ? [6, 4] : undefined,
      }));
      chartKind = "line"; stackedOpt = false;
    } else {
      // עמודות — מוערם: רכיבי-העומס המוצגים (צריכה עצמית / פריקה) בבסיס,
      // ו"סך עומס" כהשלמה מעליהם (=עומס − רכיבים מוצגים). הסתרת רכיב → העומס גדל.
      const shown = SERIES.filter(s => s.on);
      const shownComp = LOAD_COMP.filter(id => shown.some(s => s.id === id));
      datasets = [];
      for (const id of shownComp) {                              // בסיס הערימה
        const s = SERIES.find(x => x.id === id);
        datasets.push({ label: s.name, data: arr(id), backgroundColor: s.color, borderWidth: 0, stack: "L" });
      }
      if (shown.some(s => s.id === "load")) {                    // השלמה: עומס − רכיבים מוצגים
        const data = agg.order.map(k => {
          const o = agg.map.get(k), L = metricVal(o, "load");
          if (!Number.isFinite(L)) return NaN;
          let c = 0; for (const id of shownComp) { const v = metricVal(o, id); if (Number.isFinite(v)) c += Math.max(0, v); }
          return +Math.max(0, L - c).toFixed(3);
        });
        datasets.push({ label: "סך עומס", data, backgroundColor: cv("--s-load"), borderWidth: 0, stack: "L" });
      }
      // שאר הסדרות (PV/יצוא/יבוא...) — כל אחת בערימה נפרדת (עמודה לצד)
      for (const s of shown)
        if (s.id !== "load" && !LOAD_COMP.includes(s.id))
          datasets.push({ label: s.name, data: arr(s.id), backgroundColor: s.color + "CC", borderColor: s.color, borderWidth: 0, stack: "s_" + s.id });
      chartKind = "bar"; stackedOpt = true;
    }
    const cfg = {
      type: chartKind,
      data: { labels, datasets },
      options: baseOpts(unit, stackedOpt),
    };
    // רקע תעו״ז — רק כשציר-ה-X הוא שעת-יום (תצוגת יום / יום ממוצע)
    if (state.view === "day" || isAvgView()) {
      const bands = agg.order.map(k => { const o = agg.map.get(k); return o.peakN >= o.offN ? (o.peakN > 0) : false; });
      const p = { bands, peakColor: cv("--bg-peak"), offColor: cv("--bg-off") };
      // רקע הפסקת חשמל (אפור) — רק בתצוגת יום
      if (state.view === "day") {
        p.outageBands = agg.order.map(k => agg.map.get(k).outN > 0);
        p.outageColor = cv("--bg-outage");
      }
      cfg.options.plugins.tariffBg = p;
    }
    if (flowChart) flowChart.destroy();
    flowChart = new Chart(document.getElementById("flowChart"), cfg);
  }

  function renderTariff(agg) {
    const labels = agg.order.map(k => agg.map.get(k).label);
    const toIls = state.tariffUnit === "ils";
    const priceField = state.vat === "vat" ? "priceVat" : "priceNoVat";
    // מחיר ייצוגי לכל קטגוריה (קבוע לפי התעריף)
    const priceOf = {};
    for (const b of T.BUCKETS) {
      const [seas, per] = b.key.split("|");
      const cents = T.PRICE[b.key][state.vat === "vat" ? 1 : 0];
      priceOf[b.key] = cents / 100;
    }
    const datasets = T.BUCKETS.map(b => {
      const data = agg.order.map(k => {
        const kwh = agg.map.get(k).tar[b.key] || 0;
        return +(toIls ? kwh * priceOf[b.key] : kwh).toFixed(2);
      });
      return { label: b.label, data, backgroundColor: b.color, borderWidth: 0, stack: "t" };
    });
    const unit = toIls ? "₪" : "kWh";
    const cfg = { type: "bar", data: { labels, datasets }, options: baseOpts(unit, true) };
    if (tariffChart) tariffChart.destroy();
    tariffChart = new Chart(document.getElementById("tariffChart"), cfg);
  }

  // ---- אגירה: KPI כדאיות + השוואת עלות עם/בלי אגירה (הגרפים אוחדו לגרף הראשי) ----
  function renderStore(agg) {
    const pf = state.vat === "vat" ? "priceVat" : "priceNoVat";
    const sc = scope();
    let tImp = 0, tDis = 0, tChg = 0, gross = 0, chgCost = 0, opIls = 0;
    let costNo = 0, costWith = 0;
    for (let i = sc.a; i <= sc.b; i++) {
      if (sc.ok && !sc.ok(i)) continue;
      const dd = discharge[i] || 0, cc = charge[i] || 0;
      tDis += dd; tChg += cc;
      const price = slotTar[i][pf];
      gross += dd * price;                 // ערך החשמל שנצרך מהסוללה (במחיר התעו״ז שקוזז)
      chgCost += cc * price;               // עלות הטעינה (בשפל)
      const impV = Number.isFinite(imp[i]) ? imp[i] : 0;
      tImp += impV;
      costNo += impV * price;              // עלות היבוא ללא אגירה
      costWith += Math.max(0, impV + cc - dd) * price;   // עלות היבוא עם אגירה
      opIls += Math.max(0, impV - dd) * price;           // עלות תפעול מהרשת (בלי טעינה)
    }
    const net = gross - chgCost;           // הפרש מחיר = חיסכון בתחום = costNo - costWith
    const opKwh = tImp - tDis;             // צריכת תפעול מהרשת (בלי טעינה) = יבוא − פריקה
    const lossKwh = tChg - tDis;           // הפסד המרה (נצילות)
    const lossIls = tChg > 0 ? lossKwh * (chgCost / tChg) : 0;

    // חיסכון שנתי + החזר השקעה — תמיד על כל הנתונים (שנה מייצגת), לא תלוי בתצוגה,
    // אחרת עונה עם מרווח פסגה/שפל קטן תעוות את ההערכה.
    let netFull = 0, disFull = 0;
    for (let i = 0; i < N; i++) { const dd = discharge[i] || 0; netFull += (dd - (charge[i] || 0)) * slotTar[i][pf]; disFull += dd; }
    const daysFull = N / 96;
    const savePerYear = netFull * 365 / daysFull;

    // עלות התקנה (CAPEX) + החזר השקעה
    const b = state.bat, capTot = b.cab * b.cap;
    const usableCap = capTot * (b.socMax - b.socMin) / 100;
    const capex = state.cost.perKwh * capTot + state.cost.fixed;
    const payback = savePerYear > 0 ? capex / savePerYear : Infinity;
    // מחזורים שקולים לשנה = תפוקת פריקה שנתית / קיבולת שמישה
    const cyclesPerYear = usableCap > 0 ? (disFull * 365 / daysFull) / usableCap : 0;

    // שורה 1 — פירוק אנרגיה וכלכלה (קוט״ש + ₪), בתחום המוצג
    const dual = (lbl, kwh, ils, c) => `
      <div class="kpi"><div class="lbl"><span class="dot" style="background:${c}"></span>${lbl}</div>
        <div class="val">${nf0.format(Math.round(kwh))} <span class="unit">kWh</span></div>
        <div style="font-size:14px;font-weight:800;color:${c};margin-top:1px">${fmtILS(ils)}</div></div>`;
    const solo = (lbl, ils, c) => `
      <div class="kpi"><div class="lbl"><span class="dot" style="background:${c}"></span>${lbl}</div>
        <div class="val">${fmtILS(ils)}</div></div>`;
    document.getElementById("storeKpis").innerHTML =
      dual("צריכת תפעול מהרשת (בלי טעינה)", opKwh, opIls, cv("--s-imp")) +
      dual("חשמל שנטען (רשת→סוללה)", tChg, chgCost, cv("--s-charge")) +
      dual("חשמל שנצרך מהסוללה (פריקה)", tDis, gross, cv("--s-discharge")) +
      dual("הפסד המרה (נצילות)", lossKwh, lossIls, cv("--gray")) +
      solo("הפרש מחיר (חיסכון בתחום)", net, cv("--brand"));

    // שורה 2 — עלות כוללת + כדאיות השקעה
    const paybackTxt = isFinite(payback) ? nf1.format(payback) + " שנים" : "—";
    const cards2 = [
      { lbl: "עלות חשמל ללא אגירה", v: costNo, c: cv("--s-imp"), ils: true },
      { lbl: "עלות חשמל עם אגירה", v: costWith, c: cv("--brand-accent"), ils: true },
      { lbl: "חיסכון שנתי (מוערך)", v: savePerYear, c: cv("--brand"), ils: true },
      { lbl: "עלות התקנה (CAPEX)", v: capex, c: cv("--warning"), ils: true },
      { lbl: "החזר השקעה", txt: paybackTxt, c: cv("--brand-dark") },
      { lbl: "מחזורי טעינה לשנה", txt: nf0.format(Math.round(cyclesPerYear)) + " מחזורים", c: cv("--s-charge") },
    ];
    document.getElementById("storeCostKpis").innerHTML = cards2.map(c => `
      <div class="kpi"><div class="lbl"><span class="dot" style="background:${c.c}"></span>${c.lbl}</div>
      <div class="val">${c.txt ? c.txt : fmtILS(c.v)}</div></div>`).join("");

    // שורה 3 — מודל אורך-חיים: מה שמגביל קודם (מחזורים / קלנדרי) → שנות חיים → ROI מצטבר
    const lifeByCyc = cyclesPerYear > 0 ? b.maxCycles / cyclesPerYear : Infinity;
    const lifeYears = Math.min(lifeByCyc, b.calLife);
    const limiter = lifeByCyc < b.calLife ? "מחזורים" : "קלנדרי";
    const lifeSavings = savePerYear * lifeYears;
    const lifeProfit = lifeSavings - capex;
    const roi = capex > 0 ? (lifeProfit / capex) * 100 : 0;
    const cards3 = [
      { lbl: "אורך חיים צפוי", txt: (isFinite(lifeYears)?nf1.format(lifeYears):"∞") + " שנים · " + limiter, c: cv("--info") },
      { lbl: "חיסכון מצטבר לכל החיים", v: lifeSavings, c: cv("--brand"), ils: true },
      { lbl: "רווח נטו לכל החיים", v: lifeProfit, c: lifeProfit>=0?cv("--brand-accent"):cv("--danger"), ils: true },
      { lbl: "החזר השקעתי (ROI)", txt: nf0.format(Math.round(roi)) + "%", c: cv("--brand-dark") },
    ];
    document.getElementById("storeLifeKpis").innerHTML = cards3.map(c => `
      <div class="kpi"><div class="lbl"><span class="dot" style="background:${c.c}"></span>${c.lbl}</div>
      <div class="val">${c.txt ? c.txt : fmtILS(c.v)}</div></div>`).join("");

    // ימים פעילים (מחזורי סוללה) — מדד לבלאי/אורך חיים
    let activeFull = 0; const daysN = Math.floor(N / 96);
    for (let d = 0; d < daysN; d++) { for (let h = 0; h < 96; h++) { if (discharge[d*96+h] > 0) { activeFull++; break; } } }

    const usable = capTot * (b.socMax - b.socMin) / 100, pTot = b.cab * b.ac;
    document.getElementById("bSpec").innerHTML =
      `סה״כ: <b>${nf0.format(capTot)} kWh</b> · שמיש <b>${nf0.format(usable)} kWh</b> · הספק <b>${nf0.format(pTot)} kW</b>`;
    const spread = tDis > 0 ? net / tDis : 0;
    const policyTxt = b.smart
      ? `<b>אגירה חכמה:</b> הסוללה מחזורית רק כשכדאי (פסגה×נצילות > שפל) — פעילה ב-<b>${nf0.format(activeFull)} מתוך ${nf0.format(daysN)} ימים</b> (${nf0.format(100*activeFull/daysN)}%). בעונות המעבר מושבתת (מרווח זעום/מפסיד) → פחות בלאי והחזר מהיר יותר.`
      : `<b>אגירה תמיד פעילה:</b> מחזור בכל יום שיש בו פסגה, גם כשהמרווח מפסיד (עונות מעבר). מומלץ לעבור ל"חכמה".`;
    document.getElementById("storeFootnote").innerHTML =
      `עלות החשמל = עלות היבוא מהרשת בתעו״ז (${state.vat==="vat"?"כולל":"ללא"} מע״מ). רווח ממוצע נטו: <b>${nf2.format(spread)} ₪/קוט״ש נפרק</b>. ` +
      `CAPEX = ${nf0.format(state.cost.perKwh)}₪×${nf0.format(capTot)}kWh + ${nf0.format(state.cost.fixed)}₪. ${policyTxt}`;
  }

  function baseOpts(unit, stacked) {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16, font: { size: 11 } } },
        y: { stacked, beginAtZero: true, grid: { color: "#EEF1F6" },
             ticks: { font: { size: 11 }, callback: v => fmtNum(v) },
             title: { display: true, text: unit, font: { size: 11, weight: "700" }, color: "#6B7280" } },
      },
      plugins: {
        legend: { display: stacked, position: "bottom", labels: { boxWidth: 12, font: { size: 11.5 }, padding: 10 } },
        tooltip: {
          rtl: true, callbacks: {
            label: c => `${c.dataset.label}: ${unit === "₪" ? fmtILS(c.parsed.y) : fmtNum(c.parsed.y) + " " + unit}`,
          },
        },
      },
    };
  }

  // ============================ KPI + טבלה ===================================
  function renderKPIs(agg) {
    const tot = { pv:0, imp:0, exp:0, self:0, load:0 };
    let cost = 0;
    const priceField = state.vat === "vat" ? "priceVat" : "priceNoVat";
    const sc = scope();
    for (let i = sc.a; i <= sc.b; i++) {
      if (sc.ok && !sc.ok(i)) continue;
      tot.pv += pv[i]||0; tot.imp += impBat[i]||0; tot.exp += exp[i]||0;   // יבוא = מציאות (עם אגירה)
      tot.self += self[i]||0; tot.load += load[i]||0;
      const q = SERIES_ARR[state.costQty][i];
      if (Number.isFinite(q)) cost += q * slotTar[i][priceField];
    }
    const cards = [
      { lbl:"ייצור PV",     v:tot.pv,   u:"kWh", c:cv("--s-pv") },
      { lbl:"יבוא מהרשת",   v:tot.imp,  u:"kWh", c:cv("--s-imp") },
      { lbl:"יצוא לרשת",    v:tot.exp,  u:"kWh", c:cv("--s-exp") },
      { lbl:"צריכה עצמית",  v:tot.self, u:"kWh", c:cv("--s-self") },
      { lbl:"סך עומס",      v:tot.load, u:"kWh", c:cv("--s-load") },
      { lbl:"עלות תעו״ז",   v:cost,     u:"₪",   c:cv("--brand"), ils:true },
    ];
    document.getElementById("kpis").innerHTML = cards.map(c => `
      <div class="kpi">
        <div class="lbl"><span class="dot" style="background:${c.c}"></span>${c.lbl}</div>
        <div class="val">${c.ils ? fmtILS(c.v) : nf0.format(Math.round(c.v))} <span class="unit">${c.ils?"":c.u}</span></div>
      </div>`).join("");
  }

  function renderCostTable(agg) {
    const priceIdx = state.vat === "vat" ? 1 : 0;
    const rows = {}; let totKwh = 0, totCost = 0;
    for (const b of T.BUCKETS) rows[b.key] = 0;
    const sc = scope();
    for (let i = sc.a; i <= sc.b; i++) {
      if (sc.ok && !sc.ok(i)) continue;
      const q = SERIES_ARR[state.costQty][i];
      if (Number.isFinite(q)) rows[slotTar[i].key] += q;
    }
    let html = `<thead><tr><th>תעריף</th><th>אנרגיה</th><th>מחיר</th><th>עלות</th><th>%</th></tr></thead><tbody>`;
    for (const b of T.BUCKETS) {
      const kwh = rows[b.key]; const price = T.PRICE[b.key][priceIdx] / 100;
      const cost = kwh * price; totKwh += kwh; totCost += cost;
    }
    for (const b of T.BUCKETS) {
      const kwh = rows[b.key]; const price = T.PRICE[b.key][priceIdx] / 100; const cost = kwh * price;
      const pct = totCost > 0 ? (cost / totCost * 100) : 0;
      html += `<tr>
        <td><span class="swatch" style="background:${b.color}"></span>${b.label}</td>
        <td class="num">${nf0.format(Math.round(kwh))}</td>
        <td class="num">${nf2.format(price)}</td>
        <td class="num">${fmtILS(cost)}</td>
        <td class="num">${nf1.format(pct)}%</td></tr>`;
    }
    html += `<tr class="total"><td>סה״כ</td><td class="num">${nf0.format(Math.round(totKwh))}</td><td></td>
      <td class="num">${fmtILS(totCost)}</td><td class="num">100%</td></tr></tbody>`;
    document.getElementById("costTable").innerHTML = html;
    const qName = { load:"סך העומס", impBat:"היבוא מהרשת (עם אגירה)", imp:"היבוא מהרשת (בלי אגירה)", self:"הצריכה העצמית" }[state.costQty];
    document.getElementById("costFootnote").innerHTML =
      `החישוב על <b>${qName}</b> · מחירים ${state.vat==="vat"?"כולל":"ללא"} מע״מ (₪/קוט״ש). ` +
      `ממוצע משוקלל: <b>${totKwh>0?nf2.format(totCost/totKwh):"0"} ₪/קוט״ש</b>.`;
  }

  // ============================ בקרות UI =====================================
  function seg(id, opts, cur, cb) {
    const el = document.getElementById(id);
    el.innerHTML = opts.map(o => `<button data-v="${o.v}" class="${o.v===cur?"on":""}">${o.t}</button>`).join("");
    el.querySelectorAll("button").forEach(btn => btn.onclick = () => {
      el.querySelectorAll("button").forEach(b => b.classList.remove("on"));
      btn.classList.add("on"); cb(btn.dataset.v);
    });
  }

  const HE_MON_FULL = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];

  function buildControls() {
    seg("viewSeg", [
      {v:"day",t:"יום"},{v:"week",t:"שבוע"},{v:"month",t:"חודש"},{v:"year",t:"שנה"},{v:"multi",t:"רב-שנתי"},
      {v:"avgMonth",t:"יום ממוצע · חודשי"},{v:"avgSeason",t:"יום ממוצע · עונתי"},
    ], state.view, v => { state.view = v; syncViewUI(); applyView(); });

    seg("granSeg", [{v:"q",t:"15 דק׳"},{v:"hour",t:"שעה"}], state.dayGran, v => { state.dayGran = v; applyView(); });

    seg("metricSeg", [
      {v:"kwh",t:"אנרגיה kWh"},{v:"kwavg",t:"הספק ממוצע kW"},{v:"kwpeak",t:"הספק שיא kW"},
    ], state.metric, v => { state.metric = v; refreshFlow(); });

    seg("chartTypeSeg", [{v:"bar",t:"עמודות (מוערם)"},{v:"line",t:"קו"}], state.chartType, v => { state.chartType = v; refreshFlow(); });

    seg("tariffUnitSeg", [{v:"kwh",t:"kWh"},{v:"ils",t:"₪"}], state.tariffUnit, v => { state.tariffUnit = v; refreshTariff(); });
    seg("vatSeg", [{v:"vat",t:"כולל מע״מ"},{v:"novat",t:"ללא מע״מ"}], state.vat, v => { state.vat = v; refresh(); });

    document.getElementById("costQty").onchange = e => { state.costQty = e.target.value; refresh(); };
    document.getElementById("navPrev").onclick = () => shiftPeriod(-1);
    document.getElementById("navNext").onclick = () => shiftPeriod(1);
    document.getElementById("navLast").onclick = () => { state.anchor = new Date(LAST_DAY); applyView(); };
    document.getElementById("anchorDate").onchange = e => {
      if (!e.target.value) return;
      const p = e.target.value.split("-").map(Number);
      state.anchor = clampDay(new Date(Date.UTC(p[0], p[1]-1, p[2])));
      applyView();
    };

    // בקרות אגירה
    const bmap = { bCab:"cab", bCap:"cap", bAc:"ac", bMax:"socMax", bMin:"socMin", bEff:"eff" };
    for (const [id, key] of Object.entries(bmap)) {
      document.getElementById(id).onchange = e => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) { state.bat[key] = v; simulateStorage(); refresh(); }
      };
    }
    seg("smartSeg", [{v:"smart",t:"חכמה (רק כשכדאי)"},{v:"always",t:"תמיד פעילה"}],
      state.bat.smart ? "smart" : "always",
      v => { state.bat.smart = (v === "smart"); simulateStorage(); refresh(); });

    // בקרות עלות התקנה (לא משנות סימולציה — רק CAPEX/החזר)
    const cmap = { bCostKwh:"perKwh", bCostFixed:"fixed" };
    for (const [id, key] of Object.entries(cmap)) {
      document.getElementById(id).onchange = e => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) { state.cost[key] = v; refresh(); }
      };
    }
    // בקרות אורך-חיים (לא משנות סימולציה — רק מודל הכדאיות)
    const lmap = { bMaxCyc:"maxCycles", bCalLife:"calLife" };
    for (const [id, key] of Object.entries(lmap)) {
      document.getElementById(id).onchange = e => {
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) { state.bat[key] = v; refresh(); }
      };
    }
  }

  // הצגת/הסתרת בקרות לפי התצוגה
  function syncViewUI() {
    const showGran = state.view === "day" || isAvgView();
    document.getElementById("granWrap").style.display = showGran ? "" : "none";
    document.getElementById("anchorDate").style.display = (state.view === "multi" || state.view === "avgSeason") ? "none" : "";
    const dis = state.view === "multi";
    ["navPrev","navNext","navLast"].forEach(id => document.getElementById(id).disabled = dis);
  }

  function idxFromDate(y, m, d) { return Math.round((Date.UTC(y, m - 1, d, 0, 0) - BASE) / slotMs); }
  function clampDay(dt) {
    if (dt < FIRST_DAY) return new Date(FIRST_DAY);
    if (dt > LAST_DAY) return new Date(LAST_DAY);
    return dt;
  }

  // גזירת טווח התקופה + רזולוציית תת-היחידות + תווית, מתוך view + anchor
  function applyView() {
    const a = state.anchor, Y = a.getUTCFullYear(), Mo = a.getUTCMonth(), Da = a.getUTCDate();
    let s, e, label;
    state.res = VIEW_RES[state.view]();
    if (state.view === "day") {
      s = idxFromDate(Y, Mo+1, Da); e = s + 95;
      label = `יום ${HE_DOW[a.getUTCDay()]} · ${pad(Da)}/${pad(Mo+1)}/${Y}`;
    } else if (state.view === "week") {
      const ws = new Date(a); ws.setUTCDate(Da - a.getUTCDay());   // ראשון
      const we = new Date(ws); we.setUTCDate(ws.getUTCDate() + 6);
      s = idxFromDate(ws.getUTCFullYear(), ws.getUTCMonth()+1, ws.getUTCDate()); e = s + 7*96 - 1;
      label = `שבוע ${pad(ws.getUTCDate())}/${pad(ws.getUTCMonth()+1)} – ${pad(we.getUTCDate())}/${pad(we.getUTCMonth()+1)}/${we.getUTCFullYear()}`;
    } else if (state.view === "month") {
      s = idxFromDate(Y, Mo+1, 1);
      const nm = new Date(Date.UTC(Y, Mo+1, 1)); e = idxFromDate(nm.getUTCFullYear(), nm.getUTCMonth()+1, 1) - 1;
      label = `${HE_MON_FULL[Mo]} ${Y}`;
    } else if (state.view === "year") {
      s = idxFromDate(Y, 1, 1); e = idxFromDate(Y, 12, 31) + 95;
      label = `שנת ${Y}`;
    } else if (state.view === "avgMonth") {
      // יום ממוצע על פני ימי החודש הנבחר
      s = idxFromDate(Y, Mo+1, 1);
      const nm = new Date(Date.UTC(Y, Mo+1, 1)); e = idxFromDate(nm.getUTCFullYear(), nm.getUTCMonth()+1, 1) - 1;
      label = `יום ממוצע · ${HE_MON_FULL[Mo]} ${Y}`;
    } else if (state.view === "avgSeason") {
      // יום ממוצע על פני כל ימי העונה (בכל השנים) — הסינון ב-scope()
      s = 0; e = N - 1;
      label = `יום ממוצע · ${SEASON4[state.season]} (כל השנים)`;
    } else {  // multi
      s = 0; e = N - 1;
      label = `כל השנים · ${FIRST_DAY.getUTCFullYear()}–${LAST_DAY.getUTCFullYear()}`;
    }
    state.rStart = Math.max(0, s); state.rEnd = Math.min(N - 1, e);
    document.getElementById("navLabel").textContent = label;
    if (state.view !== "multi" && state.view !== "avgSeason") document.getElementById("anchorDate").value = a.toISOString().slice(0, 10);
    refresh();
  }

  function shiftPeriod(dir) {
    if (state.view === "avgSeason") { state.season = (state.season + dir + 4) % 4; applyView(); return; }
    if (state.view === "multi") return;
    const a = new Date(state.anchor);
    if (state.view === "day") a.setUTCDate(a.getUTCDate() + dir);
    else if (state.view === "week") a.setUTCDate(a.getUTCDate() + 7*dir);
    else if (state.view === "month" || state.view === "avgMonth") a.setUTCMonth(a.getUTCMonth() + dir);
    else if (state.view === "year") a.setUTCFullYear(a.getUTCFullYear() + dir);
    state.anchor = clampDay(a);
    applyView();
  }

  // ============================ רענון ========================================
  let lastAgg = null;
  function refresh() {
    lastAgg = aggregate();
    renderKPIs(lastAgg);
    renderFlow(lastAgg);
    renderTariff(lastAgg);
    renderCostTable(lastAgg);
    renderStore(lastAgg);
    renderOutages();
    updateRangeInfo();
  }

  // ---- רשימת הפסקות חשמל בתצוגה הנוכחית (לחיצה → מעבר ליום האירוע) ----
  function renderOutages() {
    const sc = scope();
    const list = OUTAGES.filter(o => o.s >= sc.a && o.s <= sc.b && (!sc.ok || sc.ok(o.s)));
    const el = document.getElementById("outageList"), sum = document.getElementById("outageSummary");
    if (!list.length) {
      el.innerHTML = `<div class="note">לא זוהו הפסקות חשמל בתצוגה זו.</div>`;
      sum.textContent = "";
      return;
    }
    let totH = 0;
    el.innerHTML = list.map(o => {
      const a = slotDate[o.s], rec = new Date(BASE + (o.e + 1) * slotMs);
      const hrs = (o.e - o.s + 1) * SLOT_H; totH += hrs;
      const dstr = `${pad(a.getUTCDate())}/${pad(a.getUTCMonth()+1)}/${a.getUTCFullYear()}`;
      const t1 = `${pad(a.getUTCHours())}:${pad(a.getUTCMinutes())}`;
      const t2 = `${pad(rec.getUTCHours())}:${pad(rec.getUTCMinutes())}`;
      return `<a class="outage-item" data-s="${o.s}"><span class="arrow">◀</span>` +
        `<span>יום ${HE_DOW[a.getUTCDay()]} · <b>${dstr}</b></span>` +
        `<span>${t1}–${t2}</span><span class="dur">${nf2.format(hrs)} ש׳</span></a>`;
    }).join("");
    sum.innerHTML = `<b>${list.length}</b> הפסקות · סה״כ <b>${nf1.format(totH)} שעות</b>`;
    el.querySelectorAll(".outage-item").forEach(it => it.onclick = () => goToDay(+it.dataset.s));
  }
  function goToDay(slotIdx) {
    const t = slotDate[slotIdx];
    state.view = "day";
    state.anchor = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    document.querySelectorAll("#viewSeg button").forEach(bt => bt.classList.toggle("on", bt.dataset.v === "day"));
    syncViewUI();
    applyView();
  }
  function refreshFlow() { if (!lastAgg) lastAgg = aggregate(); renderFlow(lastAgg); }
  function refreshTariff() { if (!lastAgg) lastAgg = aggregate(); renderTariff(lastAgg); }

  function updateRangeInfo() {
    const a = slotDate[state.rStart], b = slotDate[state.rEnd];
    const f = t => `${pad(t.getUTCDate())}/${pad(t.getUTCMonth()+1)}/${t.getUTCFullYear()}`;
    let gaps = 0;
    for (const d of GAP) if (d * 96 >= state.rStart && d * 96 <= state.rEnd) gaps++;
    const gapTxt = gaps ? ` · ⚠ ${gaps} ימי חוסר-נתונים (מונה דו-כיווני) — מוצגים כפער` : "";
    document.getElementById("rangeInfo").textContent = `תקופה מוצגת: ${f(a)} — ${f(b)}${gapTxt}`;
  }

  function renderSeriesChips() {
    const el = document.getElementById("seriesChips");
    el.innerHTML = SERIES.map(s => `
      <span class="chip ${s.on?"on":"off"}" data-id="${s.id}" style="${s.on?`color:${s.color}`:""}">
        <span class="dot" style="background:${s.color}"></span>${s.name}</span>`).join("");
    el.querySelectorAll(".chip").forEach(ch => ch.onclick = () => {
      const s = SERIES.find(x => x.id === ch.dataset.id); s.on = !s.on;
      ch.classList.toggle("on", s.on); ch.classList.toggle("off", !s.on);
      ch.style.color = s.on ? s.color : "";
      refreshFlow();
    });
  }

  // ============================ אתחול ========================================
  function init() {
    document.getElementById("custName").textContent = D.meta.customer || "לקוח";
    document.getElementById("custSub").textContent =
      `${D.meta.address || ""} · חוזה ${D.meta.contract || ""} · מונה דו-כיווני ${D.meta.meters.find(m=>m.role==="bidir").code}`;
    const tot = D.meta.totals;
    document.getElementById("buildInfo").innerHTML =
      ` · סה״כ בכל התקופה: ייצור ${nf0.format(tot.pv)} · יבוא ${nf0.format(tot.imp)} · יצוא ${nf0.format(tot.exp)} · עומס ${nf0.format(tot.load)} kWh.`;
    buildControls();
    renderSeriesChips();
    simulateStorage();                    // חישוב אגירה ראשוני
    state.anchor = new Date(LAST_DAY);   // התקופה הנוכחית = הכי עדכנית
    syncViewUI();
    applyView();                          // מחשב טווח + res + מרנדר
  }
  init();
})();
