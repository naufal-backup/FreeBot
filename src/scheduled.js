// src/scheduled.js
// Runs on the Worker's Cron Trigger: executes user-defined cron tasks whose
// time matches "now" (WIB), fires due one-off reminders, and cleans up old
// processed-update records.

import { getActiveApi } from "./models.js";
import { sendTelegram } from "./telegram.js";

export async function runScheduledTasks(env, ctx) {
  if (!env.DB) {
    console.error("runScheduledTasks: no DB");
    return;
  }

  const now = Date.now();
  const wib = new Date(now + 7 * 3600000);
  const hhmm = String(wib.getUTCHours()).padStart(2, "0") + ":" + String(wib.getUTCMinutes()).padStart(2, "0");
  const today = wib.toISOString().slice(0, 10);
  console.log("scheduled tick: " + hhmm + " WIB");

  try {
    const tasks = await env.DB.prepare(
      "SELECT id,chat_id,task_text FROM tasks WHERE active=1 AND cron_time=?"
    ).bind(hhmm).all();
    console.log("cron tasks found: " + (tasks.results || []).length);

    for (const t of tasks.results || []) {
      const r = await env.DB.prepare("SELECT last_run FROM tasks WHERE id=?").bind(t.id).first();
      if (r?.last_run && r.last_run.slice(0, 10) === today) {
        console.log("cron " + t.id + " already ran today");
        continue;
      }
      try {
        const { base_url, api_key } = await getActiveApi(env, null);
        const model = env.AI_MODEL || "deepseek-v4-flash";
        const ai = await fetch(base_url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + api_key },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: "Jawab singkat." },
              { role: "user", content: t.task_text }
            ],
            max_tokens: 500
          })
        });
        const d = await ai.json();
        const reply = (d?.choices?.[0]?.message?.content || "").trim().slice(0, 1000);
        await sendTelegram(env.TELEGRAM_TOKEN, t.chat_id, "\u23F0 **Cron " + t.cron_time + "**: " + reply);
        await env.DB.prepare("UPDATE tasks SET last_run=? WHERE id=?").bind(new Date().toISOString(), t.id).run();
        console.log("cron " + t.id + " executed");
      } catch (e) {
        console.error("cron task error:", e.message);
      }
    }
  } catch (e) {
    console.error("cron query error:", e.message);
  }

  try {
    const rems = await env.DB.prepare(
      "SELECT id,chat_id,message FROM pending_reminders WHERE done=0 AND remind_at<=?"
    ).bind(now).all();
    console.log("pending reminders due: " + (rems.results || []).length);

    for (const r of rems.results || []) {
      await sendTelegram(env.TELEGRAM_TOKEN, r.chat_id, "\u{1F514} **Pengingat:** " + r.message);
      await env.DB.prepare("UPDATE pending_reminders SET done=1 WHERE id=?").bind(r.id).run();
      console.log("reminder " + r.id + " sent");
    }
  } catch (e) {
    console.error("reminder error:", e.message);
  }

  try {
    await env.DB.prepare("DELETE FROM processed_updates WHERE created_at < ?").bind(Date.now() - 7 * 86400000).run();
  } catch (e) {
    console.error("cleanup processed_updates:", e.message);
  }
}
