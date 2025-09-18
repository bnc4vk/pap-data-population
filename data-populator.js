// data-populator.js
import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { setTimeout as wait } from "timers/promises";

// ---------- Logging ----------
function logWithTimestamp(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

// ---------- Supabase Setup ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------- Substances + Countries ----------
const SUBSTANCES = [
  "Ketamine",
  "MDMA",
  "Psilocybin",
  "Lysergic Acid Diethylamide",
];

// 193 UN member states (ISO 3166-1 alpha-2 codes)
const COUNTRIES = [
  "AF","AL","DZ","AD","AO","AG","AR","AM","AU","AT","AZ","BS","BH","BD","BB","BY","BE","BZ","BJ","BT","BO","BA","BW","BR","BN","BG","BF","BI",
  "CV","KH","CM","CA","CF","TD","CL","CN","CO","KM","CD","CG","CR","CI","HR","CU","CY","CZ","DK","DJ","DM","DO","EC","EG","SV","GQ","ER","EE","SZ",
  "ET","FJ","FI","FR","GA","GM","GE","DE","GH","GR","GD","GT","GN","GW","GY","HT","HN","HU","IS","IN","ID","IR","IQ","IE","IL","IT","JM","JP","JO",
  "KZ","KE","KI","KP","KR","KW","KG","LA","LV","LB","LS","LR","LY","LI","LT","LU","MG","MW","MY","MV","ML","MT","MH","MR","MU","MX","FM","MD","MC",
  "MN","ME","MA","MZ","MM","NA","NR","NP","NL","NZ","NI","NE","NG","MK","NO","OM","PK","PW","PS","PA","PG","PY","PE","PH","PL","PT","QA","RO","RU",
  "RW","KN","LC","VC","WS","SM","ST","SA","SN","RS","SC","SL","SG","SK","SI","SB","SO","ZA","SS","ES","LK","SD","SR","SE","CH","SY","TJ","TZ","TH",
  "TL","TG","TO","TT","TN","TR","TM","TV","UG","UA","AE","GB","US","UY","UZ","VU","VE","VN","YE","ZM","ZW"
];

// ---------- LLM Helper ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function withRetry(fn, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;

      if (err.status === 429 || (err.status && err.status >= 500)) {
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
        logWithTimestamp(
          "WARN",
          `[LLM] Retry attempt ${attempt} after ${delay}ms due to ${err.status || err.message}`
        );
        await wait(delay);
      } else {
        throw err;
      }
    }
  }
}

class LLMSource {
  constructor(model = "gpt-4o-mini") {
    this.model = model;
  }

  async getAccessStatuses(substances, countries) {
    const prompt = `For each of the following substances and countries, determine their current legal or medical access status (e.g., Approved Medical Use, Banned, Limited Access Trials, Unknown).
Substances: ${substances.join(", ")} 
Countries: ${countries.join(", ")} 
Respond ONLY in strict JSON as an array of objects with keys: substance, country_code, access_status.`;

    const response = await withRetry(() =>
      openai.chat.completions.create({
        model: this.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a precise legal/medical data provider. Always output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
      })
    );

    let raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("Empty response from LLM");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error("Failed to parse LLM JSON: " + raw.slice(0, 200));
    }

    if (!Array.isArray(parsed)) {
      const firstArray = Object.values(parsed).find((v) => Array.isArray(v));
      if (firstArray) {
        parsed = firstArray;
      } else {
        throw new Error("Expected array of records, got: " + JSON.stringify(parsed));
      }
    }

    return parsed;
  }
}

// ---------- Save to Supabase ----------
async function upsertRecords(records) {
  for (const rec of records) {
    const { substance, country_code, access_status } = rec;

    const { data: existing, error: fetchErr } = await supabase
      .from("psychedelic_access")
      .select("*")
      .eq("substance", substance)
      .eq("country_code", country_code)
      .maybeSingle();

    if (fetchErr) {
      logWithTimestamp(
        "ERROR",
        `❌ Fetch error for ${substance}-${country_code}: ${fetchErr.message}`
      );
      continue;
    }

    if (!existing) {
      const { error: insertErr } = await supabase
        .from("psychedelic_access")
        .insert([
          {
            substance,
            country_code,
            access_status,
            updated_at: new Date().toISOString(),
          },
        ]);
      if (insertErr) {
        logWithTimestamp(
          "ERROR",
          `❌ Insert error for ${substance}-${country_code}: ${insertErr.message}`
        );
      } else {
        logWithTimestamp(
          "INFO",
          `✓ Inserted ${substance} in ${country_code} = ${access_status}`
        );
      }
    } else if (existing.access_status !== access_status) {
      const { error: updateErr } = await supabase
        .from("psychedelic_access")
        .update({
          access_status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      if (updateErr) {
        logWithTimestamp(
          "ERROR",
          `❌ Update error for ${substance}-${country_code}: ${updateErr.message}`
        );
      } else {
        logWithTimestamp(
          "INFO",
          `✓ Updated ${substance} in ${country_code}: ${existing.access_status} → ${access_status}`
        );
      }
    } else {
      logWithTimestamp(
        "INFO",
        `↺ Skipped ${substance} in ${country_code}: no change`
      );
    }
  }
}

// ---------- Main ----------
async function main() {
  logWithTimestamp("INFO", "=== Psychedelic Data Updater Started ===");

  const llm = new LLMSource("gpt-4o-mini");
  const batchSize = 25;
  let allResults = [];

  for (let i = 0; i < COUNTRIES.length; i += batchSize) {
    const batch = COUNTRIES.slice(i, i + batchSize);
    logWithTimestamp(
      "INFO",
      `[LLM] Querying ${llm.model} for ${SUBSTANCES.length} substances × ${batch.length} countries (batch ${i / batchSize + 1})...`
    );
    const results = await llm.getAccessStatuses(SUBSTANCES, batch);
    allResults = allResults.concat(results);
    await wait(2000); // throttle between batches
  }

  await upsertRecords(allResults);

  logWithTimestamp("INFO", "=== Finished ===");
}

main().catch((err) => {
  logWithTimestamp("ERROR", `Fatal error: ${err.stack || err}`);
  process.exit(1);
});
