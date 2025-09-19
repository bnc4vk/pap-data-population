import "dotenv/config";
import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// --- CONFIG ---
const PORT = process.env.PORT || 3001;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- ROUTE: search-substance ---
app.post("/api/search-substance", async (req, res) => {
  const { substance } = req.body;
  if (!substance) {
    return res.status(400).json({ error: "Missing substance" });
  }

  try {
    // 1. Ask OpenAI for global access statuses
    const prompt = `
    You are given a psychedelic substance name: "${substance}".
    Return a JSON object where keys are ISO 3166-1 alpha-2 country codes
    (e.g., "US", "CA", "BR") and values are one of:
      - "Unknown"
      - "Banned"
      - "Limited Access Trials"
      - "Approved Medical Use"
    Only include countries where you have information, otherwise omit them.
    Respond with ONLY valid JSON.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // light + cheap model
      messages: [
        { role: "system", content: "You are a strict data API." },
        { role: "user", content: prompt }
      ],
      temperature: 0
    });

    let parsed;
    try {
      parsed = JSON.parse(completion.choices[0].message.content);
    } catch (e) {
      console.error("Failed to parse OpenAI output:", completion.choices[0].message.content);
      return res.status(500).json({ error: "Invalid JSON from OpenAI" });
    }

    console.log("OpenAI result:", parsed);

    // 2. Upsert into Supabase table
    const rows = Object.entries(parsed).map(([country_code, access_status]) => ({
      substance,
      country_code,
      access_status
    }));

    const supabaseRes = await fetch(`${SUPABASE_URL}/rest/v1/psychedelic_access`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
      },
      body: JSON.stringify(rows)
    });

    if (!supabaseRes.ok) {
      const text = await supabaseRes.text();
      console.error("Supabase error:", text);
      return res.status(500).json({ error: "Failed to upsert to Supabase", details: text });
    }

    return res.json({ success: true, inserted: rows.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
