// src/utils/time.js
// Parses natural-language (Indonesian/English) time expressions into a UTC
// epoch millisecond timestamp, resolved against WIB (UTC+7).

export function parseNaturalTime(text) {
  const norm = (text || "").toLowerCase().trim();
  const now = Date.now();
  const wibOff = 7 * 3600000;
  const wibNow = new Date(now + wibOff);
  let target = new Date(wibNow);

  const rel = norm.match(
    /(?:(?:dalam|in|after)\s+)?(\d+)\s*(menit|min(?:ute)?s?|mins?|m|jam|hours?|hour|h|hari|days?|day|d)\s*(lagi|)$/
  );
  if (rel) {
    const n = parseInt(rel[1], 10);
    const u = rel[2];
    const ms =
      u.startsWith("menit") || u.startsWith("min") || u === "m"
        ? 60000
        : u.startsWith("jam") || u.startsWith("hour") || u === "h"
        ? 3600000
        : 86400000;
    return now + n * ms;
  }

  if (/besok|tomorrow/.test(norm)) target.setUTCDate(target.getUTCDate() + 1);
  if (/lusa|day after/.test(norm)) target.setUTCDate(target.getUTCDate() + 2);

  const days = { minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6 };
  const dm = norm.match(/(?:next |)(senin|selasa|rabu|kamis|jumat|sabtu|ahad|minggu)/);
  if (dm) {
    let diff = (days[dm[1]] - target.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    target.setUTCDate(target.getUTCDate() + diff);
  }

  const hm = norm.match(/(\d{1,2})[:.](\d{2})/);
  if (hm) {
    target.setUTCHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
  } else {
    const hx = norm.match(/(?:jam |pukul |at |)(\d{1,2})\s*(pagi|siang|sore|malam|am|pm)?\b/);
    if (hx) {
      let h = parseInt(hx[1], 10);
      const sfx = hx[2] || "";
      if ((sfx === "siang" || sfx === "sore" || sfx === "malam" || sfx === "pm") && h < 12) h += 12;
      if ((sfx === "pagi" || sfx === "am") && h === 12) h = 0;
      target.setUTCHours(h, 0, 0, 0);
    } else {
      return null;
    }
  }

  if (target.getTime() <= wibNow.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - wibOff;
}
