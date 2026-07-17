/* ------------------------------------------------------------------ *
 * מודול תעו״ז — מתח נמוך, חברת החשמל (בתוקף מ־01.07.2026)
 * מסווג כל סלוט 15-דק' לפי עונה + תקופה, ומחזיר את מחיר הקוט״ש.
 * זהה ללוגיקה שבממיר ה-CSV (IEC TAOZ CSV/generate_taoz_csv.py).
 * ------------------------------------------------------------------ */
window.TARIFF = (function () {
  // מחיר אג'/קוט״ש: [ללא מע״מ, כולל מע״מ] → נשמר גם כ-₪
  const PRICE = {
    "קיץ|פסגה":       [145.96, 172.23],
    "קיץ|שפל":        [42.73, 50.42],
    "חורף|פסגה":      [97.20, 114.70],
    "חורף|שפל":       [39.52, 46.63],
    "אביב/סתיו|פסגה": [42.02, 49.58],
    "אביב/סתיו|שפל":  [38.80, 45.78],
  };

  // צבעים נמשכים מ-theme.css (מקור יחיד)
  const cv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || "#888";
  // 6 קטגוריות התעריף (פסגה=חם, שפל=בהיר)
  const BUCKETS = [
    { key: "קיץ|פסגה",       label: "קיץ · פסגה",       color: cv("--t-summer-peak") },
    { key: "קיץ|שפל",        label: "קיץ · שפל",        color: cv("--t-summer-off") },
    { key: "חורף|פסגה",      label: "חורף · פסגה",      color: cv("--t-winter-peak") },
    { key: "חורף|שפל",       label: "חורף · שפל",       color: cv("--t-winter-off") },
    { key: "אביב/סתיו|פסגה", label: "אביב/סתיו · פסגה", color: cv("--t-trans-peak") },
    { key: "אביב/סתיו|שפל",  label: "אביב/סתיו · שפל",  color: cv("--t-trans-off") },
  ];

  // חגים בטווח הנתונים (2024-07 .. 2026-07) — מטופלים כשבתות, ערביהם כימי ו'
  const HOLIDAYS = new Set([
    "2024-10-03", "2024-10-12", "2024-10-17", "2024-10-24",
    "2025-04-13", "2025-04-19", "2025-05-01", "2025-06-02",
    "2025-09-23", "2025-10-02", "2025-10-07", "2025-10-14",
    "2026-04-02", "2026-04-08", "2026-04-22", "2026-05-22",
  ]);
  const EVES = new Set([...HOLIDAYS].map(d => {
    const t = new Date(d + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  }));

  function season(month) {
    if (month >= 6 && month <= 9) return "קיץ";
    if (month === 12 || month === 1 || month === 2) return "חורף";
    return "אביב/סתיו";
  }

  // dow: 0=ראשון .. 6=שבת (getUTCDay)
  function isWeekday(dateStr, dow) {
    if (HOLIDAYS.has(dateStr)) return false;   // חג = שבת
    if (EVES.has(dateStr)) return false;       // ערב חג = יום ו'
    return dow >= 0 && dow <= 4;               // ראשון-חמישי
  }

  function period(seas, weekday, hour) {
    if (seas === "קיץ")  return (weekday && hour >= 17 && hour <= 22) ? "פסגה" : "שפל";
    if (seas === "חורף") return (hour >= 17 && hour <= 21) ? "פסגה" : "שפל"; // כל הימים
    return (weekday && hour >= 17 && hour <= 21) ? "פסגה" : "שפל";          // אביב/סתיו
  }

  /* מקבל שדות שעון-קיר של הסלוט → { key, seas, per, priceNoVat, priceVat } (₪/קוט״ש) */
  function classify(dateStr, dow, month, hour) {
    const seas = season(month);
    const wd = isWeekday(dateStr, dow);
    const per = period(seas, wd, hour);
    const key = seas + "|" + per;
    const p = PRICE[key];
    return { key, seas, per, priceNoVat: p[0] / 100, priceVat: p[1] / 100 };
  }

  return { PRICE, BUCKETS, classify, season, period, isWeekday };
})();
