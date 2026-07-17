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
  const D = window.METER_DATA, T = window.TARIFF;
  const N = D.meta.n, STEP_MIN = D.meta.stepMinutes;      // 15
  const SLOT_H = STEP_MIN / 60;                            // 0.25 שעה לסלוט

  // בסיס זמן ב-UTC כדי לייצג "שעון קיר" ללא תלות ב-DST של המחשב
  const bp = D.meta.start.split(/[-T:]/).map(Number);      // [Y,M,D,h,m]
  const BASE = Date.UTC(bp[0], bp[1] - 1, bp[2], bp[3], bp[4]);
  const slotMs = STEP_MIN * 60000;

  // ---- סדרות גולמיות + נגזרות (per-slot) ----
  const pv = D.pv, cons = D.cons, imp = D.imp, exp = D.exp;
  const self = new Float32Array(N), load = new Float32Array(N), bidir = new Float32Array(N);
  const slotDate = new Array(N);       // אובייקט Date (UTC=שעון קיר) לכל סלוט
  const slotTar = new Array(N);        // סיווג תעו״ז לכל סלוט
  for (let i = 0; i < N; i++) {
    const s = Math.max(0, (pv[i] || 0) - (exp[i] || 0));
    self[i] = s;
    load[i] = Math.max(0, (imp[i] || 0) + (pv[i] || 0) - (exp[i] || 0));
    bidir[i] = (imp[i] || 0) - (exp[i] || 0);   // נטו על המונה הדו-כיווני
    const t = new Date(BASE + i * slotMs);
    slotDate[i] = t;
    const ds = t.toISOString().slice(0, 10);
    slotTar[i] = T.classify(ds, t.getUTCDay(), t.getUTCMonth() + 1, t.getUTCHours());
  }
  // מערכי אגירה (מחושבים ע"י simulateStorage) — נכללים באגרגציה
  const charge = new Float32Array(N), discharge = new Float32Array(N), soc = new Float32Array(N);
  const SERIES_ARR = { pv, imp, exp, self, load, cons, bidir, charge, discharge, soc };

  // ---- הגדרת סדרות לתצוגה (צבעים מ-theme.css) ----
  const SERIES = [
    { id: "load", name: "סך עומס",        color: cv("--s-load"), on: true },
    { id: "imp",  name: "יבוא מהרשת",      color: cv("--s-imp"),  on: true },
    { id: "pv",   name: "ייצור PV",        color: cv("--s-pv"),   on: true },
    { id: "exp",  name: "יצוא לרשת",       color: cv("--s-exp"),  on: true },
    { id: "self", name: "צריכה עצמית",     color: cv("--s-self"), on: true },
    { id: "cons", name: "מונה צריכה",      color: cv("--s-cons"), on: false },
  ];

  // ---- מצב ----
  // מודל "תצוגת תקופה": בוחרים תקופה (יום/שבוע/חודש/שנה/רב-שנתי) ומנווטים בין תקופות.
  // כל תקופה מפורקת לתת-יחידות טבעיות (res): יום→רבע-שעה/שעה, שבוע/חודש→יום, שנה→חודש, רב-שנתי→שנה.
  const state = {
    view: "month",          // day | week | month | year | multi
    dayGran: "q",           // q | hour   (רק בתצוגת יום)
    metric: "kwh",          // kwh | kwavg | kwpeak
    chartType: "bar",       // line | bar
    costQty: "load",
    tariffUnit: "kwh",      // kwh | ils
    vat: "vat",             // vat | novat
    anchor: null,           // Date (UTC חצות) המייצג את התקופה הנוכחית
    res: "day", rStart: 0, rEnd: N - 1,   // נגזרים מ-view+anchor
    bat: { cab: 1, cap: 261, ac: 125, socMax: 95, socMin: 20, eff: 90 },  // אגירה
  };
  const VIEW_RES = { day: () => state.dayGran, week: () => "day", month: () => "day", year: () => "month", multi: () => "year" };
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
  function aggregate() {
    const order = [], map = new Map();
    const a = Math.max(0, state.rStart), b = Math.min(N - 1, state.rEnd);
    for (let i = a; i <= b; i++) {
      const bk = bucketOf(i);
      let o = map.get(bk.key);
      if (!o) {
        o = { label: bk.label, hours: 0, n: 0,
              vals: { pv:0, imp:0, exp:0, self:0, load:0, cons:0, bidir:0, charge:0, discharge:0 },
              peak: { pv:0, imp:0, exp:0, self:0, load:0, cons:0, bidir:0 },
              tar: {} };
        map.set(bk.key, o); order.push(bk.key);
      }
      o.n++; o.hours += SLOT_H;
      for (const s of SERIES) {
        const v = SERIES_ARR[s.id][i] || 0;
        o.vals[s.id] += v;
        const pw = v / SLOT_H;                 // הספק רגעי (kW) של הסלוט
        if (pw > o.peak[s.id]) o.peak[s.id] = pw;
      }
      o.vals.charge += charge[i] || 0;
      o.vals.discharge += discharge[i] || 0;
      // פילוח תעו״ז — על הכמות הנבחרת לחיוב
      const q = SERIES_ARR[state.costQty][i] || 0;
      const tk = slotTar[i].key;
      o.tar[tk] = (o.tar[tk] || 0) + q;
    }
    return { order, map, a, b };
  }

  // ============================ סימולציית אגירה ==============================
  // מודל ארביטראז' יומי: פורק בשעות פסגה כדי לקזז יבוא (בלי יצוא לרשת),
  // וטוען בשעות שפל (עדיפות לפני הפסגה). מחשב charge[], discharge[], soc[].
  function simulateStorage() {
    const b = state.bat;
    charge.fill(0); discharge.fill(0); soc.fill(0);
    const capTot = b.cab * b.cap;                          // kWh כולל
    const usable = capTot * (b.socMax - b.socMin) / 100;   // kWh שמיש
    const pMax15 = b.cab * b.ac * SLOT_H;                  // kWh לרבע-שעה בהספק AC מלא
    const eff = Math.max(0.01, b.eff / 100);
    const socMinK = capTot * b.socMin / 100;
    if (capTot <= 0 || usable <= 0 || pMax15 <= 0) return;
    const days = Math.floor(N / 96);
    for (let d = 0; d < days; d++) {
      const s0 = d * 96, s1 = s0 + 95;
      // פריקה בפסגה: מקזז יבוא, מוגבל בהספק, בקיבולת שמישה
      let Edis = 0;
      for (let i = s0; i <= s1 && Edis < usable; i++) {
        if (slotTar[i].per !== "פסגה") continue;
        const dd = Math.min(imp[i] || 0, pMax15, usable - Edis);
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
  }

  // ערך סדרה לפי המדד הנבחר
  function metricVal(o, id) {
    if (state.metric === "kwh") return o.vals[id];
    if (state.metric === "kwpeak") return o.peak[id];
    return o.hours > 0 ? o.vals[id] / o.hours : 0;   // kwavg
  }

  // ============================ פורמט ========================================
  const nf0 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum = v => Math.abs(v) >= 1000 ? nf0.format(v) : nf1.format(v);
  const fmtILS = v => "₪" + nf0.format(v);
  function metricUnit() { return state.metric === "kwh" ? "kWh" : "kW"; }

  // ============================ צ'ארטים ======================================
  let flowChart, tariffChart, chargeChart, dischargeChart;

  function renderFlow(agg) {
    const labels = agg.order.map(k => agg.map.get(k).label);
    const unit = metricUnit();
    const datasets = SERIES.filter(s => s.on).map(s => {
      const data = agg.order.map(k => +metricVal(agg.map.get(k), s.id).toFixed(3));
      return {
        label: s.name, data, borderColor: s.color, backgroundColor: s.color + (state.chartType==="bar"?"CC":"22"),
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .18, fill: state.chartType === "line" ? false : true,
      };
    });
    const cfg = {
      type: state.chartType,
      data: { labels, datasets },
      options: baseOpts(unit, false),
    };
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

  // ---- אגירה: גרפי טעינה/פריקה + KPI חיסכון ----
  function oneBar(canvasId, existing, labels, data, color, unit) {
    const cfg = {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: color, borderWidth: 0 }] },
      options: baseOpts(unit, false),
    };
    cfg.options.plugins.legend = { display: false };
    if (existing) existing.destroy();
    return new Chart(document.getElementById(canvasId), cfg);
  }

  function renderStore(agg) {
    const labels = agg.order.map(k => agg.map.get(k).label);
    const chg = agg.order.map(k => +(agg.map.get(k).vals.charge).toFixed(2));
    const dis = agg.order.map(k => +(agg.map.get(k).vals.discharge).toFixed(2));
    chargeChart = oneBar("chargeChart", chargeChart, labels, chg, cv("--s-charge"), "kWh");
    dischargeChart = oneBar("dischargeChart", dischargeChart, labels, dis, cv("--s-discharge"), "kWh");

    // חיסכון על הטווח הנראה
    const pf = state.vat === "vat" ? "priceVat" : "priceNoVat";
    let tDis = 0, tChg = 0, gross = 0, chgCost = 0, peakOff = 0;
    for (let i = agg.a; i <= agg.b; i++) {
      const dd = discharge[i] || 0, cc = charge[i] || 0;
      tDis += dd; tChg += cc;
      gross += dd * slotTar[i][pf];       // ערך אנרגיית הפסגה שקוזזה
      chgCost += cc * slotTar[i][pf];     // עלות טעינה בשפל
      if (dd > 0) peakOff += dd;
    }
    const net = gross - chgCost;
    const cards = [
      { lbl: "אנרגיה שנטענה", v: tChg, u: "kWh", c: cv("--s-charge") },
      { lbl: "אנרגיה שנפרקה", v: tDis, u: "kWh", c: cv("--s-discharge") },
      { lbl: "ערך הפסגה שקוזז", v: gross, c: cv("--brand-accent"), ils: true },
      { lbl: "עלות טעינה בשפל", v: chgCost, c: cv("--warning"), ils: true },
      { lbl: "חיסכון נטו", v: net, c: cv("--brand"), ils: true },
    ];
    document.getElementById("storeKpis").innerHTML = cards.map(c => `
      <div class="kpi"><div class="lbl"><span class="dot" style="background:${c.c}"></span>${c.lbl}</div>
      <div class="val">${c.ils ? fmtILS(c.v) : nf0.format(Math.round(c.v))} <span class="unit">${c.ils?"":c.u}</span></div></div>`).join("");

    const b = state.bat;
    const capTot = b.cab * b.cap, usable = capTot * (b.socMax - b.socMin) / 100, pTot = b.cab * b.ac;
    document.getElementById("bSpec").innerHTML =
      `סה״כ: <b>${nf0.format(capTot)} kWh</b> · שמיש <b>${nf0.format(usable)} kWh</b> · הספק <b>${nf0.format(pTot)} kW</b>`;
    const spread = tDis > 0 ? net / tDis : 0;
    document.getElementById("storeFootnote").innerHTML =
      `מודל: פריקה בפסגה לקיזוז יבוא (ללא יצוא לרשת), טעינה בשפל · מחירים ${state.vat==="vat"?"כולל":"ללא"} מע״מ · ` +
      `רווח ממוצע נטו: <b>${nf2.format(spread)} ₪/קוט״ש נפרק</b>. הגדל את מס׳ הקבינטים כדי להגדיל את החיסכון עד לתקרת הפסגה היומית.`;
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
    for (let i = agg.a; i <= agg.b; i++) {
      tot.pv += pv[i]||0; tot.imp += imp[i]||0; tot.exp += exp[i]||0;
      tot.self += self[i]||0; tot.load += load[i]||0;
      cost += (SERIES_ARR[state.costQty][i]||0) * slotTar[i][priceField];
    }
    const cards = [
      { lbl:"ייצור PV",     v:tot.pv,   u:"kWh", c:"#F4A200" },
      { lbl:"יבוא מהרשת",   v:tot.imp,  u:"kWh", c:"#E23B4E" },
      { lbl:"יצוא לרשת",    v:tot.exp,  u:"kWh", c:"#16A34A" },
      { lbl:"צריכה עצמית",  v:tot.self, u:"kWh", c:"#2563EB" },
      { lbl:"סך עומס",      v:tot.load, u:"kWh", c:"#0A1628" },
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
    for (let i = agg.a; i <= agg.b; i++) {
      const q = SERIES_ARR[state.costQty][i] || 0;
      rows[slotTar[i].key] += q;
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
    const qName = { load:"סך העומס", imp:"היבוא מהרשת", self:"הצריכה העצמית" }[state.costQty];
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
    ], state.view, v => { state.view = v; syncViewUI(); applyView(); });

    seg("granSeg", [{v:"q",t:"15 דק׳"},{v:"hour",t:"שעה"}], state.dayGran, v => { state.dayGran = v; applyView(); });

    seg("metricSeg", [
      {v:"kwh",t:"אנרגיה kWh"},{v:"kwavg",t:"הספק ממוצע kW"},{v:"kwpeak",t:"הספק שיא kW"},
    ], state.metric, v => { state.metric = v; refreshFlow(); });

    seg("chartTypeSeg", [{v:"bar",t:"עמודות"},{v:"line",t:"קו"}], state.chartType, v => { state.chartType = v; refreshFlow(); });

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
  }

  // הצגת/הסתרת בקרות לפי התצוגה
  function syncViewUI() {
    document.getElementById("granWrap").style.display = state.view === "day" ? "" : "none";
    document.getElementById("anchorDate").style.display = state.view === "multi" ? "none" : "";
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
    } else {  // multi
      s = 0; e = N - 1;
      label = `כל השנים · ${FIRST_DAY.getUTCFullYear()}–${LAST_DAY.getUTCFullYear()}`;
    }
    state.rStart = Math.max(0, s); state.rEnd = Math.min(N - 1, e);
    document.getElementById("navLabel").textContent = label;
    if (state.view !== "multi") document.getElementById("anchorDate").value = a.toISOString().slice(0, 10);
    refresh();
  }

  function shiftPeriod(dir) {
    if (state.view === "multi") return;
    const a = new Date(state.anchor);
    if (state.view === "day") a.setUTCDate(a.getUTCDate() + dir);
    else if (state.view === "week") a.setUTCDate(a.getUTCDate() + 7*dir);
    else if (state.view === "month") a.setUTCMonth(a.getUTCMonth() + dir);
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
    updateRangeInfo();
  }
  function refreshFlow() { if (!lastAgg) lastAgg = aggregate(); renderFlow(lastAgg); }
  function refreshTariff() { if (!lastAgg) lastAgg = aggregate(); renderTariff(lastAgg); }

  function updateRangeInfo() {
    const a = slotDate[state.rStart], b = slotDate[state.rEnd];
    const f = t => `${pad(t.getUTCDate())}/${pad(t.getUTCMonth()+1)}/${t.getUTCFullYear()}`;
    document.getElementById("rangeInfo").textContent = `תקופה מוצגת: ${f(a)} — ${f(b)}`;
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
