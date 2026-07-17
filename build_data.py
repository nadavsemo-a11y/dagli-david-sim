# -*- coding: utf-8 -*-
"""
עיבוד קובץ קריאות המונה של חברת החשמל לסדרת זמן נקייה עבור הדאשבורד.

קלט : meter_LP_...csv  (יצוא IEC, רזולוציית 15 דק')
פלט : meter_data.js    (window.METER_DATA — מערכים מקבילים ברשת 15-דק' אחידה)

מיפוי מונים (נגזר מניתוח הנתונים):
  ייצור (PV)   : 503-24707415, 738-21002689, 738-21002691  → מסוכמים ל-pv
  צריכה        : 737-18000661 (עמ' "צריכה") → cons  (מודד יבוא מהרשת בפועל)
  דו-כיווני    : 737-18000646 → imp (עמ' "צריכה"=יבוא), exp (עמ' "הזרמה"=יצוא)

גדלים נגזרים (מחושבים בדאשבורד):
  צריכה עצמית = pv - exp     (הספק PV שיוצר ונצרך במקום, מחויב בתעו"ז)
  סך עומס     = imp + pv - exp
"""

import csv
import json
from collections import defaultdict
from datetime import datetime, timedelta

SRC = r"C:\Users\97252\Downloads\meter_LP_568445599F772A95E0639020FE0AD0D9_nadav.s@s-a.gs.csv"
OUT = r"C:\Users\97252\Documents\אוטומציות ותכנותים\STORAGE CALCULATOR\סימולציה דגלי דוד\meter_data.js"

# מוני ייצור. 738-21002689 ו-738-21002691 הם *אותה מדידה* (מונה בקרה + מסחרי):
# זהים עד הספרה ב-70% מהסלוטים, בהפרש < 0.1 קוט"ש ב-99.7%, מתאם 0.9985.
# לכן הייצור האמיתי = PV1 + max(PV2,PV3) — ולא סכום שלושתם (שהיה מנפח את הייצור ~פי 2,
# ומראה שיא צהריים ~448kW במקום ~249kW האמיתיים, שתואם AC < 300kW במתקן).
PV1_CODE = "503-24707415"
PV_DUP_CODES = ("738-21002689", "738-21002691")   # כפילות — לוקחים max פר סלוט
CONS_CODE = "737-18000661"
BIDIR_CODE = "737-18000646"

# ---------------------------------------------------------------------------
# קריאת הקובץ → מילון לפי datetime
# ---------------------------------------------------------------------------
data = defaultdict(lambda: {"pv1": 0.0, "pv2": 0.0, "pv3": 0.0, "cons": 0.0, "imp": 0.0, "exp": 0.0})
meta = {"customer": "", "address": "", "contract": ""}

with open(SRC, encoding="utf-8-sig") as f:
    reader = csv.reader(f)
    want_customer = False
    for row in reader:
        if not row:
            continue
        c0 = row[0].strip()
        # פרטי לקוח: הכותרת "שם לקוח" ואז (מדלגים על שורות רווח) שורת הערכים
        if c0 == "שם לקוח":
            want_customer = True
            continue
        if want_customer:
            if c0 in ("", " ", "  "):   # שורת רווח מפרידה — מדלגים
                continue
            if len(row) >= 3:
                meta["customer"] = c0
                meta["address"] = row[1].strip()
                meta["contract"] = row[2].strip()
            want_customer = False

        if "-" in c0 and c0.split("-")[0].isdigit() and len(row) >= 6:
            try:
                val = float(row[4]) if row[4].strip() not in ("", " ") else 0.0
                flow = float(row[5]) if row[5].strip() not in ("", " ") else 0.0
                dt = datetime.strptime(row[2].strip() + " " + row[3].strip(), "%d/%m/%Y %H:%M")
            except ValueError:
                continue
            slot = data[dt]
            if c0 == PV1_CODE:
                slot["pv1"] += val
            elif c0 == PV_DUP_CODES[0]:
                slot["pv2"] += val
            elif c0 == PV_DUP_CODES[1]:
                slot["pv3"] += val
            elif c0 == CONS_CODE:
                slot["cons"] += val
            elif c0 == BIDIR_CODE:
                slot["imp"] += val
                slot["exp"] += flow

# ---------------------------------------------------------------------------
# בניית רשת 15-דק' אחידה מ-min עד max (שעון קיר; פערי DST זניחים)
# ---------------------------------------------------------------------------
tmin = min(data.keys())
tmax = max(data.keys())
# יישור תחילת הרשת ל-00:00
start = tmin.replace(hour=0, minute=0, second=0, microsecond=0)
step = timedelta(minutes=15)

n = int((tmax - start) / step) + 1
pv1 = [0.0] * n
pv2 = [0.0] * n
pv3 = [0.0] * n
cons = [0.0] * n
imp = [0.0] * n
exp = [0.0] * n

for dt, s in data.items():
    i = int((dt - start) / step)
    if 0 <= i < n:
        pv1[i] += s["pv1"]
        pv2[i] += s["pv2"]
        pv3[i] += s["pv3"]
        cons[i] += s["cons"]
        imp[i] += s["imp"]
        exp[i] += s["exp"]

# ייצור אמיתי פר סלוט: PV1 + max(PV2,PV3) — הסרת הכפילות של מוני 738
pv = [pv1[i] + max(pv2[i], pv3[i]) for i in range(n)]


def r2(x):
    x = round(x, 2)
    return int(x) if x == int(x) else x


pv = [r2(x) for x in pv]
cons = [r2(x) for x in cons]
imp = [r2(x) for x in imp]
exp = [r2(x) for x in exp]

# ---------------------------------------------------------------------------
# סיכומים לאימות ולכותרת הדאשבורד
# ---------------------------------------------------------------------------
sum_pv = sum(pv)
sum_cons = sum(cons)
sum_imp = sum(imp)
sum_exp = sum(exp)
self_cons = sum_pv - sum_exp
total_load = sum_imp + sum_pv - sum_exp

meta.update({
    "start": start.strftime("%Y-%m-%dT%H:%M"),
    "end": tmax.strftime("%Y-%m-%dT%H:%M"),
    "stepMinutes": 15,
    "n": n,
    "meters": [
        {"role": "PV", "formula": "PV1 + max(PV2,PV3)", "pv1": PV1_CODE, "dup": list(PV_DUP_CODES)},
        {"role": "cons", "code": CONS_CODE},
        {"role": "bidir", "code": BIDIR_CODE},
    ],
    "totals": {
        "pv": r2(sum_pv), "cons": r2(sum_cons), "imp": r2(sum_imp),
        "exp": r2(sum_exp), "self": r2(self_cons), "load": r2(total_load),
    },
})

payload = {"meta": meta, "pv": pv, "cons": cons, "imp": imp, "exp": exp}

with open(OUT, "w", encoding="utf-8") as f:
    f.write("window.METER_DATA = ")
    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    f.write(";\n")

import os
size_mb = os.path.getsize(OUT) / 1e6
print(f"customer     : {meta['customer']} | {meta['address']} | {meta['contract']}")
print(f"slots (n)    : {n}  ({start} .. {tmax})")
print(f"PV total     : {sum_pv:,.0f} kWh")
print(f"CONS meter   : {sum_cons:,.0f} kWh")
print(f"Grid import  : {sum_imp:,.0f} kWh")
print(f"Grid export  : {sum_exp:,.0f} kWh")
print(f"Self-consump : {self_cons:,.0f} kWh   (pv - exp)")
print(f"Total load   : {total_load:,.0f} kWh   (imp + pv - exp)")
print(f"output       : {OUT}  ({size_mb:.2f} MB)")
